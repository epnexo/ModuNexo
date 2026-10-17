import { NextResponse } from "next/server";
import { resolveViewer } from "./viewer.ts";

export const MAX_BODY_BYTES = 64 * 1024;

/**
 * A browser sends `Origin` on every cross-site and every same-site write, and a page on another site cannot make
 * it name this host. The writes behind `/api/settings` insist on it, in addition to the session cookie being
 * SameSite=Lax. Forwarding headers are not consulted: a client can write them.
 */
export function sameOriginRequest(headers: Pick<Headers, "get">): boolean {
  const origin = headers.get("origin");
  const host = headers.get("host");
  if (origin === null || host === null) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export const json = (body: unknown, status = 200): NextResponse => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

export type ParsedBody = { ok: true; body: unknown } | { ok: false; message: string };

export function parseJsonBody(text: string): ParsedBody {
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) return { ok: false, message: `the request body is larger than ${MAX_BODY_BYTES} bytes` };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, message: "the request body is not valid JSON" };
  }
}

/**
 * Everything a settings write needs before it looks at the body: same origin, a viewer, and the right to write.
 * The gate in front of the app has already required a session, and this asks again at the point of use. The
 * response is the refusal to return, or the actor to record.
 */
export async function authorizeWrite(request: Request): Promise<{ actor: string } | NextResponse> {
  if (!sameOriginRequest(request.headers)) return json({ error: "cross-origin request refused" }, 403);
  const viewer = await resolveViewer(request.headers);
  if (viewer === null) return json({ error: "sign-in required" }, 401);
  if (!viewer.canWrite) return json({ error: "only an administrator can change settings" }, 403);
  return { actor: viewer.actor };
}

export type BodyText = { ok: true; text: string } | { ok: false; message: string };

/**
 * The request body as text, read at most up to the limit: a declared length over it is refused before anything is
 * read, and a stream that goes past it is cancelled as soon as it does, so a client cannot make the server buffer
 * more than the limit.
 */
export async function readBodyText(request: Request): Promise<BodyText> {
  const tooLarge: BodyText = { ok: false, message: `the request body is larger than ${MAX_BODY_BYTES} bytes` };
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    await request.body?.cancel().catch(() => undefined);
    return tooLarge;
  }
  if (request.body === null) return { ok: true, text: "" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return tooLarge;
    }
    chunks.push(value);
  }
  return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
}

export async function readJsonBody(request: Request): Promise<ParsedBody> {
  const body = await readBodyText(request);
  return body.ok ? parseJsonBody(body.text) : body;
}

export type BodyBytes = { ok: true; bytes: Buffer } | { ok: false; message: string };

/** The request body as bytes under the same bounded-read rule as `readBodyText`, for an upload with its own limit. */
export async function readBodyBytes(request: Request, limit: number): Promise<BodyBytes> {
  const tooLarge: BodyBytes = { ok: false, message: `the request body is larger than ${limit} bytes` };
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await request.body?.cancel().catch(() => undefined);
    return tooLarge;
  }
  if (request.body === null) return { ok: true, bytes: Buffer.alloc(0) };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return tooLarge;
    }
    chunks.push(value);
  }
  return { ok: true, bytes: Buffer.concat(chunks) };
}
