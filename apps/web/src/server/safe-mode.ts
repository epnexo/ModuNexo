import { type NextRequest, NextResponse } from "next/server";

/** Set by `?nocss=1`, removed by `?nocss=0`: while it is there no custom CSS is applied in this browser. */
export const SAFE_MODE_COOKIE = "modunexo.nocss";

/** What the query asks for: on, off, or no change. Only the two exact values count. */
export function safeModeChange(search: URLSearchParams): "on" | "off" | null {
  const value = search.get("nocss");
  return value === "1" ? "on" : value === "0" ? "off" : null;
}

/**
 * The way out of a custom stylesheet that made a page unusable, the sign-in page included: the cookie for the session and the
 * same page again without the parameter. It only ever runs after the access gate let the request through, and the only thing
 * it switches is whether the company's CSS is added.
 */
export function safeModeRedirect(request: NextRequest, change: "on" | "off"): NextResponse {
  const url = request.nextUrl.clone();
  url.searchParams.delete("nocss");
  const response = NextResponse.redirect(url);
  response.headers.set("cache-control", "no-store");
  if (change === "on") response.cookies.set(SAFE_MODE_COOKIE, "1", { path: "/", sameSite: "lax" });
  else response.cookies.set(SAFE_MODE_COOKIE, "", { path: "/", sameSite: "lax", maxAge: 0 });
  return response;
}
