import { readSignInMode } from "@epnexo/core/auth";
import type { Subject } from "./nav.ts";
import { platform } from "./platform.ts";
import { sessionIsUsable } from "./session.ts";

export interface Viewer {
  subject: Subject;
  /** Who is recorded as having made a change. */
  actor: string;
  /** What the top bar shows; null for the local operator. */
  email: string | null;
  /** May change settings: an administrator, or the local operator while sign-in is off. */
  canWrite: boolean;
}

/**
 * Who is asking, from the request's headers: the local operator while sign-in is off, otherwise the signed-in
 * user. Null means there is nobody the shell may serve (no session, or a banned user).
 */
export async function resolveViewer(headers: Headers): Promise<Viewer | null> {
  const { pool, auth } = platform();
  if ((await readSignInMode(pool)) === "disabled") return { subject: { kind: "operator" }, actor: "local operator", email: null, canWrite: true };
  const session = await auth.api.getSession({ headers });
  if (session === null || !sessionIsUsable(session.user)) return null;
  return { subject: { kind: "user", role: session.user.role }, actor: session.user.email, email: session.user.email, canWrite: session.user.role === "admin" };
}
