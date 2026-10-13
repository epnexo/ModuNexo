import { isLocalHostName, readSignInMode, requestIsLocal } from "@epnexo/core/auth";
import { type NextRequest, NextResponse } from "next/server";
import { decideAccess } from "./server/access.ts";
import { requestAddresses } from "./server/client-address.ts";
import { platform } from "./server/platform.ts";
import { createRefusalLog } from "./server/refusal-log.ts";
import { sessionIsUsable } from "./server/session.ts";

const refusalLog = createRefusalLog((line) => console.warn(line));

const text = (message: string, status: number) =>
  new NextResponse(message, { status, headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" } });

/**
 * Runs before every page and route handler, so it is the one gate the generated module routes cannot forget.
 * It only gathers facts; `decideAccess` decides. Anything that goes wrong while gathering them is a 503, never
 * an allow.
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  try {
    const { pool, auth } = platform();
    const mode = await readSignInMode(pool);
    const addresses = requestAddresses(request.headers);
    const local = requestIsLocal(addresses);
    const hostOk = isLocalHostName(request.headers.get("host") ?? "");
    // The library answers its own endpoints; every other path needs to know whether there is a session.
    const needsSession = mode === "required" && !pathname.startsWith("/api/auth");
    const session = needsSession ? await auth.api.getSession({ headers: request.headers }) : null;
    const hasSession = session !== null && sessionIsUsable(session.user);

    const decision = decideAccess({ pathname, mode, hasSession, local, hostOk });
    if (decision.action === "allow") return NextResponse.next();
    if (decision.action === "redirect") {
      const url = request.nextUrl.clone();
      url.pathname = decision.to;
      url.search = "";
      return NextResponse.redirect(url);
    }
    if (mode === "disabled" && decision.status === 403) {
      // The client gets nothing; the operator gets the reason and the way out.
      const why = !local ? `a request address is not local (${addresses.join(", ") || "none was stamped"})` : `the Host header is not a local name (${request.headers.get("host") ?? "missing"})`;
      refusalLog(!local ? "not-local" : "bad-host", `refused ${request.method} ${pathname}: ${why}. Sign-in is disabled, so only local requests are served; run "npm run epnexo -- auth require" to ask for a sign-in instead.`);
    }
    return text(decision.message, decision.status);
  } catch (error) {
    console.error("access check failed:", error instanceof Error ? error.message : error);
    return text("Service unavailable", 503);
  }
}

export const config = {
  // Static assets carry no data and are fetched before the page can render; everything else goes through the gate.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
