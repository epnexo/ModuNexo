import { TokenService } from "@modunexo/core/tokens";
import type { McpKeysDeps } from "./mcp-keys-api.ts";
import { platform } from "./platform.ts";
import { webRegistry } from "./registry.ts";
import { resolveViewer } from "./viewer.ts";

/** The real dependencies of the MCP keys routes: this process's database, registry and the signed-in viewer. */
export function mcpKeysDeps(): McpKeysDeps {
  const tokens = new TokenService(platform().pool, webRegistry());
  return {
    viewer: (headers) => resolveViewer(headers),
    now: () => new Date(),
    service: {
      list: () => tokens.list("core"),
      find: (id) => tokens.find(id),
      create: (input) => tokens.create(input),
      revoke: (id, actor) => tokens.revoke(id, actor),
    },
  };
}
