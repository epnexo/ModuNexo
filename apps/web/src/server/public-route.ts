import { createHmac, timingSafeEqual } from "node:crypto";
import { log } from "@modunexo/core/log";
import { type PublicRouteDeclaration, getSetting } from "@modunexo/sdk";
import { CLIENT_IP_HEADER } from "./client-address.ts";
import { createRateLimiter } from "./rate-limit.ts";

/** What the generated route file passes in: the declaration plus where it came from. */
export type PublicRouteRule = { moduleId: string; path: string } & PublicRouteDeclaration;

type Handler = (request: Request, context?: unknown) => Response | Promise<Response>;

const DEFAULT_RATE_PER_MINUTE = 60;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_TOLERANCE_SECONDS = 300;
const HEX_DIGEST = /^[0-9a-fA-F]{64}$/;
const BASE64_DIGEST = /^[A-Za-z0-9+/]{43}=$/;
const UNIX_SECONDS = /^\d{1,12}$/;

export interface PublicRouteDeps {
  /** The shared secret of the route, or null when it has no value. May throw when the setting cannot be read. */
  getSecret: (moduleId: string, key: string) => Promise<string | null>;
  now: () => number;
  /** Receives the reason for a refusal. The caller never sees it; the operator's log does. */
  warn: (reason: string) => void;
}

const reply = (status: number, message: string, extra: Record<string, string> = {}) =>
  new Response(message, { status, headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8", ...extra } });

/** One answer for every authentication failure, so the response never tells a caller which check it failed. */
const unauthorized = () => reply(401, "Unauthorized");

/** Reads the body up to `max` bytes. Returns null as soon as it goes over, without reading the rest. */
async function readLimited(request: Request, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > max) return null;
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** The digest the caller sent, or null when the header is not in the declared format. */
function sentDigest(header: string | null, rule: PublicRouteRule): Buffer | null {
  if (header === null) return null;
  const { prefix, encoding = "hex" } = rule.signature;
  let text = header;
  if (prefix !== undefined) {
    if (!text.startsWith(prefix)) return null;
    text = text.slice(prefix.length);
  }
  if (encoding === "hex") return HEX_DIGEST.test(text) ? Buffer.from(text, "hex") : null;
  return BASE64_DIGEST.test(text) ? Buffer.from(text, "base64") : null;
}

/**
 * Builds the wrapper the generated route files use. The wrapper rate limits by client, caps the body, checks the
 * HMAC-SHA256 of the raw bytes (and, when declared, the timestamp) against the module's secret setting in constant
 * time, and only then calls the module handler with the same body. Every failure answers without calling it.
 *
 * The rate limit lives in this process's memory, so with several instances each keeps its own count.
 */
export function createPublicRoute(deps: PublicRouteDeps) {
  const limiter = createRateLimiter(deps.now);

  /** Counts this request; returns the seconds to wait when the client is over its limit, else 0. */
  function limited(rule: PublicRouteRule, request: Request): number {
    // A request with no client address (not stamped by the web server) shares one bucket: stricter, never looser.
    const key = `${rule.moduleId}\n${rule.path}\n${request.headers.get(CLIENT_IP_HEADER) ?? ""}`;
    return limiter.hit(key, rule.ratePerMinute ?? DEFAULT_RATE_PER_MINUTE);
  }

  return function publicRoute(rule: PublicRouteRule, handler: Handler | undefined): (request: Request, context?: unknown) => Promise<Response> {
    return async (request, context) => {
      if (handler === undefined) return reply(405, "Method not allowed");
      const where = `${request.method} ${rule.path}`;

      const wait = limited(rule, request);
      if (wait > 0) {
        deps.warn(`${where}: rate limit exceeded`);
        return reply(429, "Too many requests", { "retry-after": String(wait) });
      }

      const body = await readLimited(request, rule.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
      if (body === null) {
        deps.warn(`${where}: body over the limit`);
        return reply(413, "Payload too large");
      }

      const { signature } = rule;
      let secret: string | null;
      try {
        secret = await deps.getSecret(rule.moduleId, signature.secret);
      } catch (error) {
        deps.warn(`${where}: the secret setting "${signature.secret}" could not be read (${error instanceof Error ? error.message : String(error)})`);
        return unauthorized();
      }
      if (secret === null || secret === "") {
        deps.warn(`${where}: the secret setting "${signature.secret}" has no value, so every request is refused`);
        return unauthorized();
      }

      let signed: Uint8Array = body;
      if (signature.timestampHeader !== undefined) {
        const sent = request.headers.get(signature.timestampHeader);
        const seconds = sent !== null && UNIX_SECONDS.test(sent) ? Number(sent) : null;
        const tolerance = signature.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
        if (seconds === null || Math.abs(deps.now() / 1000 - seconds) > tolerance) {
          deps.warn(`${where}: missing, malformed or stale timestamp`);
          return unauthorized();
        }
        signed = Buffer.concat([Buffer.from(`${sent}.`), body]);
      }

      const expected = createHmac("sha256", secret).update(signed).digest();
      const sent = sentDigest(request.headers.get(signature.header), rule);
      if (sent === null || sent.length !== expected.length || !timingSafeEqual(sent, expected)) {
        deps.warn(`${where}: signature missing or does not match`);
        return unauthorized();
      }

      // The body was consumed to check it, so the module gets a request that carries the same bytes.
      const forwarded = new Request(request.url, { method: request.method, headers: request.headers, body });
      return handler(forwarded, context);
    };
  };
}

async function settingSecret(moduleId: string, key: string): Promise<string | null> {
  const value = await getSetting(moduleId, key);
  return typeof value === "string" ? value : null;
}

/** The wrapper the generated route files import. */
export const publicRoute = createPublicRoute({
  getSecret: settingSecret,
  now: () => Date.now(),
  warn: (reason) => log.warn("public_route.refused", { detail: reason }),
});
