import type { SignInMode } from "@epnexo/core/auth";

export interface AccessInput {
  /** The request path, without the query string. */
  pathname: string;
  mode: SignInMode;
  hasSession: boolean;
  /** Every address the request carries is local (see `requestIsLocal`). */
  local: boolean;
  /** The `Host` header names a place on the local network (see `isLocalHostName`). */
  hostOk: boolean;
  /** The visitor holds every permission the path needs (true when it needs none). */
  permitted: boolean;
}

export type AccessDecision =
  | { action: "allow" }
  | { action: "redirect"; to: string }
  | { action: "deny"; status: 401 | 403; message: string };

const LOGIN_PATH = "/login";
const AUTH_API_PREFIX = "/api/auth";
const LOGO_PATH = "/api/brand/logo";

/** The sign-in page, the library's endpoints and the brand logo (the sign-in page shows it), which a visitor without a session has to reach. */
export function isPublicPath(pathname: string): boolean {
  return pathname === LOGIN_PATH || pathname === `${LOGIN_PATH}/` || pathname === AUTH_API_PREFIX || pathname.startsWith(`${AUTH_API_PREFIX}/`) || pathname === LOGO_PATH;
}

const isApi = (pathname: string) => pathname === "/api" || pathname.startsWith("/api/");

/**
 * The one place that decides who gets in. It is a pure function of four facts so that every case can be tested
 * without a server, and the proxy that calls it only gathers those facts.
 *
 * With sign-in disabled the shell is a local tool: a request that carries any non-local address, or that names a
 * public host, is refused outright, before anything else is considered, and the refusal says nothing about why
 * (the server log does). While sign-in is required the host does not matter: the session cookie belongs to the
 * host that set it, so a page on another site has no session to ride.
 */
export function decideAccess({ pathname, mode, hasSession, local, hostOk, permitted }: AccessInput): AccessDecision {
  if (mode === "disabled") {
    if (!local || !hostOk) return { action: "deny", status: 403, message: "Forbidden" };
    // There is no sign-in page to show, and nobody to sign out.
    if (pathname === LOGIN_PATH || pathname === `${LOGIN_PATH}/`) return { action: "redirect", to: "/" };
    return permitted ? { action: "allow" } : { action: "deny", status: 403, message: "Forbidden" };
  }

  if (pathname === LOGIN_PATH || pathname === `${LOGIN_PATH}/`) return hasSession ? { action: "redirect", to: "/" } : { action: "allow" };
  if (isPublicPath(pathname)) return { action: "allow" };
  // Authentication first: a visitor without a session is sent to sign in and told nothing about permissions.
  if (hasSession) return permitted ? { action: "allow" } : { action: "deny", status: 403, message: "Forbidden" };
  if (isApi(pathname)) return { action: "deny", status: 401, message: "Sign-in required" };
  return { action: "redirect", to: LOGIN_PATH };
}
