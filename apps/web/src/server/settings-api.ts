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

export async function readJsonBody(request: Request): Promise<ParsedBody> {
  return parseJsonBody(await request.text());
}
