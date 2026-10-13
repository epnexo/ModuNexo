import { readSignInMode, requestIsLocal } from "@epnexo/core/auth";
import { type NextRequest, NextResponse } from "next/server";
import { decideAccess } from "./server/access.ts";
import { requestAddresses } from "./server/client-address.ts";
import { platform } from "./server/platform.ts";

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
    const local = requestIsLocal(requestAddresses(request.headers));
    // The library answers its own endpoints; every other path needs to know whether there is a session.
    const needsSession = mode === "required" && !pathname.startsWith("/api/auth");
    const session = needsSession ? await auth.api.getSession({ headers: request.headers }) : null;

    const decision = decideAccess({ pathname, mode, hasSession: session !== null, local });
    if (decision.action === "allow") return NextResponse.next();
    if (decision.action === "redirect") {
      const url = request.nextUrl.clone();
      url.pathname = decision.to;
      url.search = "";
      return NextResponse.redirect(url);
    }
    return new NextResponse(decision.message, { status: decision.status, headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" } });
  } catch (error) {
    console.error("access check failed:", error instanceof Error ? error.message : error);
    return new NextResponse("Service unavailable", { status: 503, headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" } });
  }
}

export const config = {
  // Static assets carry no data and are fetched before the page can render; everything else goes through the gate.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
