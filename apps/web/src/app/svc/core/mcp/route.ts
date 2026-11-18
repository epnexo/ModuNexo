import { scopedRoute } from "@/server/scoped-route";

// The platform's own keyed route (see `platformPublicRoutes`). The gate lets the request reach this file without a
// session; `scopedRoute` is what checks the key. The MCP adapter itself arrives in the next task, so for now a valid
// key meets an honest "not implemented" and nothing else.
const rule = { moduleId: "core", path: "/svc/core/mcp", scope: "mcp:read" };

export const POST = scopedRoute(rule, async () => new Response("MCP over HTTP is not available yet", { status: 501, headers: { "cache-control": "no-store" } }));
