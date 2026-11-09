export type SidebarState = "open" | "rail";

/** The cookie that remembers a viewer's choice. It is a convenience, never a permission: nothing is decided by it. */
export const SIDEBAR_COOKIE = "modunexo.sidebar";

/** What the cookie holds, as one of the two states that exist; anything else (missing, edited by hand) is the open sidebar. */
export function parseSidebar(value: string | undefined): SidebarState {
  return value === "rail" ? "rail" : "open";
}

/** The `Set-Cookie`-style string the browser writes: for the whole site, a year, same-site, and Secure when the page is https. */
export function sidebarCookie(state: SidebarState, secure: boolean): string {
  return `${SIDEBAR_COOKIE}=${state}; Path=/; Max-Age=31536000; SameSite=Lax${secure ? "; Secure" : ""}`;
}
