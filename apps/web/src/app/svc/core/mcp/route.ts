import { join } from "node:path";
import { log } from "@modunexo/core/log";
import { TokenService } from "@modunexo/core/tokens";
import { CORE_VERSION } from "@modunexo/core/version";
import { repoRoot } from "@/server/apps-deps";
import { allowedChildEnv, createCliRun } from "@/server/mcp-cli";
import { createMcpHttpHandler } from "@/server/mcp-http";
import { platform } from "@/server/platform";
import { webRegistry } from "@/server/registry";
import { scopedRoute } from "@/server/scoped-route";

// The platform's own keyed route (see `platformPublicRoutes`). `scopedRoute` has already checked the key and its
// `mcp.read` scope when the handler runs; the handler asks once more, for `mcp.write`, to decide which tools exist.
const rule = { moduleId: "core", path: "/svc/core/mcp", scope: "mcp.read" };

const handler = createMcpHttpHandler({
  // A child process, like the Apps screen starts one: the CLI is never imported into the web bundle.
  run: (argv, io) => {
    const root = repoRoot();
    return createCliRun({ entry: ["--import", "tsx", join(root, "packages", "core", "src", "cli", "index.ts")], cwd: root, env: allowedChildEnv(process.env) })(argv, io);
  },
  version: CORE_VERSION,
  identify: async (token) => {
    const tokens = new TokenService(platform().pool, webRegistry());
    const read = await tokens.verify(token, { moduleId: "core", scope: "mcp.read" });
    // `scopedRoute` just checked this key; if it no longer verifies (revoked in between) nothing may run.
    if (!read.ok) throw new Error("the key no longer verifies");
    const write = await tokens.verify(token, { moduleId: "core", scope: "mcp.write" });
    return { keyId: read.tokenId, write: write.ok };
  },
  // One JSON line per call on the server log: key id, tool, exit code. No argument value, no key, no CLI text.
  audit: (event) => log.info("mcp.call", { ...event }),
});

export const POST = scopedRoute(rule, handler);
