import { log } from "@modunexo/core/log";
import { TokenService, type VerifyResult } from "@modunexo/core/tokens";
import { CLIENT_IP_HEADER } from "./client-address.ts";
import { platform } from "./platform.ts";
import { createRateLimiter } from "./rate-limit.ts";
import { webRegistry } from "./registry.ts";

/** What the generated route file passes in: where the route is and the scope its caller's token must hold. */
export interface ScopedRouteRule {
  moduleId: string;
  path: string;
  scope: string;
}

type Handler = (request: Request, context?: unknown) => Response | Promise<Response>;

const RATE_PER_MINUTE = 120;
const BEARER = /^Bearer\s+(\S+)$/i;

export interface ScopedRouteDeps {
  verify: (token: string, need: { moduleId: string; scope: string }) => Promise<VerifyResult>;
  now: () => number;
  /** Receives the reason for a refusal. The caller never sees it; the operator's log does. It never holds a token. */
  warn: (reason: string) => void;
}

const reply = (status: number, message: string, extra: Record<string, string> = {}) =>
  new Response(message, { status, headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8", ...extra } });

/** One answer for every authentication failure, so the response never says which check failed. */
const unauthorized = () => reply(401, "Unauthorized", { "www-authenticate": "Bearer" });

/**
 * Builds the wrapper the generated route files use for a route a service token opens. The wrapper rate limits by
 * client, reads `Authorization: Bearer <token>`, asks the token service whether that token belongs to this module,
 * holds the route's scope and is still good, and only then calls the module handler with the request untouched
 * (the body is not read here). Every failure answers without calling it.
 *
 * The rate limit lives in this process's memory, so with several instances each keeps its own count.
 */
export function createScopedRoute(deps: ScopedRouteDeps) {
  const limiter = createRateLimiter(deps.now);

  return function scopedRoute(rule: ScopedRouteRule, handler: Handler | undefined): (request: Request, context?: unknown) => Promise<Response> {
    return async (request, context) => {
      if (handler === undefined) return reply(405, "Method not allowed");
      const where = `${request.method} ${rule.path}`;

      // A request with no client address (not stamped by the web server) shares one bucket: stricter, never looser.
      const wait = limiter.hit(`${rule.moduleId}\n${rule.path}\n${request.headers.get(CLIENT_IP_HEADER) ?? ""}`, RATE_PER_MINUTE);
      if (wait > 0) {
        deps.warn(`${where}: rate limit exceeded`);
        return reply(429, "Too many requests", { "retry-after": String(wait) });
      }

      const match = BEARER.exec(request.headers.get("authorization") ?? "");
      if (match === null) {
        deps.warn(`${where}: no bearer token`);
        return unauthorized();
      }

      let result: VerifyResult;
      try {
        result = await deps.verify(match[1]!, { moduleId: rule.moduleId, scope: rule.scope });
      } catch (error) {
        // Not a verdict on the caller: the platform could not check. Fail closed, and say so honestly.
        deps.warn(`${where}: the token could not be checked (${error instanceof Error ? error.message : String(error)})`);
        return reply(503, "Service unavailable");
      }
      if (!result.ok) {
        deps.warn(`${where}: token refused (${result.reason})`);
        return result.reason === "forbidden_scope" ? reply(403, "Forbidden") : unauthorized();
      }
      return handler(request, context);
    };
  };
}

/** The wrapper the generated route files import. */
export const scopedRoute = createScopedRoute({
  verify: (token, need) => new TokenService(platform().pool, webRegistry()).verify(token, need),
  now: () => Date.now(),
  warn: (reason) => log.warn("scoped_route.refused", { detail: reason }),
});
