import { runCli } from "@modunexo/core/cli";
import { TokenService } from "@modunexo/core/tokens";
import { CORE_VERSION } from "@modunexo/core/version";
import { createMcpHttpHandler } from "@/server/mcp-http";
import { platform } from "@/server/platform";
import { webRegistry } from "@/server/registry";
import { scopedRoute } from "@/server/scoped-route";

// The platform's own keyed route (see `platformPublicRoutes`). `scopedRoute` has already checked the key and its
// `mcp:read` scope when the handler runs; the handler asks once more, for `mcp:write`, to decide which tools exist.
const rule = { moduleId: "core", path: "/svc/core/mcp", scope: "mcp:read" };

const handler = createMcpHttpHandler({
  run: runCli,
  version: CORE_VERSION,
  canWrite: async (token) => (await new TokenService(platform().pool, webRegistry()).verify(token, { moduleId: "core", scope: "mcp:write" })).ok,
});

export const POST = scopedRoute(rule, handler);
