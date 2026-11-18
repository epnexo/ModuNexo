import { handleRevokeMcpKey } from "../../../../../server/mcp-keys-api.ts";
import { mcpKeysDeps } from "../../../../../server/mcp-keys-deps.ts";
import { parseTokenId } from "../../../../../server/module-tokens-api.ts";

export const dynamic = "force-dynamic";

/** Stops one MCP key from working at once. */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleRevokeMcpKey(request, parseTokenId((await context.params).id), mcpKeysDeps());
}
