import type { SignInMode } from "@epnexo/core/auth";

export interface AccessInput {
  /** The request path, without the query string. */
  pathname: string;
  mode: SignInMode;
  hasSession: boolean;
  /** Every address the request carries is local (see `requestIsLocal`). */
  local: boolean;
}

export type AccessDecision =
  | { action: "allow" }
  | { action: "redirect"; to: string }
  | { action: "deny"; status: 401 | 403; message: string };

const LOGIN_PATH = "/login";
const AUTH_API_PREFIX = "/api/auth";

/** The sign-in page and the library's endpoints, which a visitor without a session has to reach. */
export function isPublicPath(pathname: string): boolean {
  return pathname === LOGIN_PATH || pathname === `${LOGIN_PATH}/` || pathname === AUTH_API_PREFIX || pathname.startsWith(`${AUTH_API_PREFIX}/`);
}

const isApi = (pathname: string) => pathname === "/api" || pathname.startsWith("/api/");

/**
 * The one place that decides who gets in. It is a pure function of four facts so that every case can be tested
 * without a server, and the proxy that calls it only gathers those facts.
 *
 * With sign-in disabled the shell is a local tool: a request that carries any non-local address is refused
 * outright, before anything else is considered, and the refusal says nothing about why.
 */
export function decideAccess({ pathname, mode, hasSession, local }: AccessInput): AccessDecision {
  if (mode === "disabled") {
    if (!local) return { action: "deny", status: 403, message: "Forbidden" };
    // There is no sign-in page to show, and nobody to sign out.
    if (pathname === LOGIN_PATH || pathname === `${LOGIN_PATH}/`) return { action: "redirect", to: "/" };
    return { action: "allow" };
  }

  if (pathname === LOGIN_PATH || pathname === `${LOGIN_PATH}/`) return hasSession ? { action: "redirect", to: "/" } : { action: "allow" };
  if (isPublicPath(pathname) || hasSession) return { action: "allow" };
  if (isApi(pathname)) return { action: "deny", status: 401, message: "Sign-in required" };
  return { action: "redirect", to: LOGIN_PATH };
}
