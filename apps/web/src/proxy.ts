import {
  CLIENT_IP_HEADER,
  effectiveClientAddress,
  isLocalHostName,
  readSignInMode,
  readTrustedProxies,
  requestIsLocal,
  splitForwarded,
} from "@modunexo/core/auth";
import { log } from "@modunexo/core/log";
import { type NextRequest, NextResponse } from "next/server";
import { modules } from "./generated/modules.ts";
import { HEALTH_PATH, decideAccess } from "./server/access.ts";
import { requestAddresses } from "./server/client-address.ts";
import { DEGRADED_BODY } from "./server/health.ts";
import { type Subject, subjectCan } from "./server/nav.ts";
import { isPublicRoute, permissionRules, publicRouteRules, requiredPermissions } from "./server/route-permissions.ts";
import { resolvePublicUrl } from "./server/launch.ts";
import { servedOverHttpsWithoutPublicUrl } from "./server/public-url-warning.ts";
import { platform } from "./server/platform.ts";
import { createRefusalLog } from "./server/refusal-log.ts";
import { sessionIsUsable } from "./server/session.ts";

const refusalLog = createRefusalLog((line) => log.warn("access.refused", { detail: line }));

/** What the manifests of this build say about who may reach which path. Fixed at build time, like the registry. */
const PERMISSION_RULES = permissionRules(modules);
const PUBLIC_ROUTES = publicRouteRules(modules);

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
    const publicRoute = isPublicRoute(pathname, PUBLIC_ROUTES);
    const needsSession = mode === "required" && !pathname.startsWith("/api/auth") && !publicRoute;
    const session = needsSession ? await auth.api.getSession({ headers: request.headers }) : null;
    const hasSession = session !== null && sessionIsUsable(session.user);

    if (servedOverHttpsWithoutPublicUrl(request.headers, resolvePublicUrl())) {
      refusalLog("https-without-public-url", 'requests arrive over HTTPS but WEB_PUBLIC_URL is not an https origin, so session cookies are not marked Secure; set WEB_PUBLIC_URL to the public https address.');
    }
    // The local operator and an administrator hold every permission; nobody else holds any (there is no way yet to
    // grant one), so a path that asks for a permission is theirs alone.
    const subject: Subject = mode === "disabled" ? { kind: "operator" } : { kind: "user", role: session?.user.role };
    const permitted = requiredPermissions(pathname, PERMISSION_RULES).every((permission) => subjectCan(subject, permission));

    const decision = decideAccess({ pathname, mode, hasSession, local, hostOk, permitted, publicRoute });
    if (decision.action === "allow") {
      // Behind a proxy the owner trusts, the sign-in limiter should count the client the proxy saw, not the proxy.
      // Only the header the limiter reads is rewritten; the locality rule above used the original request.
      const forwarded = request.headers.get("x-forwarded-for");
      const connection = request.headers.get(CLIENT_IP_HEADER);
      if (forwarded !== null && connection !== null) {
        const trusted = await readTrustedProxies(pool);
        if (trusted.length > 0) {
          const effective = effectiveClientAddress(connection, splitForwarded(forwarded), trusted);
          if (effective !== connection) {
            const headers = new Headers(request.headers);
            headers.set(CLIENT_IP_HEADER, effective);
            return NextResponse.next({ request: { headers } });
          }
        }
      }
      return NextResponse.next();
    }
    if (decision.action === "redirect") {
      const url = request.nextUrl.clone();
      url.pathname = decision.to;
      url.search = "";
      return NextResponse.redirect(url);
    }
    if (mode === "disabled" && decision.status === 403) {
      // The client gets nothing; the operator gets the reason and the way out.
      const why = !local ? `a request address is not local (${addresses.join(", ") || "none was stamped"})` : `the Host header is not a local name (${request.headers.get("host") ?? "missing"})`;
      refusalLog(!local ? "not-local" : "bad-host", `refused ${request.method} ${pathname}: ${why}. Sign-in is disabled, so only local requests are served; run "npm run modunexo -- auth require" to ask for a sign-in instead.`);
    }
    return text(decision.message, decision.status);
  } catch (error) {
    log.error("access.check_failed", { error });
    // A probe expects its own body even when the gate cannot reach the database to let it through.
    if (pathname === HEALTH_PATH) return NextResponse.json(DEGRADED_BODY, { status: 503, headers: { "cache-control": "no-store" } });
    return text("Service unavailable", 503);
  }
}

export const config = {
  // Static assets carry no data and are fetched before the page can render; everything else goes through the gate.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
