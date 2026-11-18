import { handleCreateMcpKey, handleListMcpKeys } from "../../../../server/mcp-keys-api.ts";
import { mcpKeysDeps } from "../../../../server/mcp-keys-deps.ts";

export const dynamic = "force-dynamic";

/** The keys of the MCP endpoint: names, prefixes, scopes and dates, never a key value. */
export async function GET(request: Request) {
  return handleListMcpKeys(request, mcpKeysDeps());
}

/** A new read key for the MCP endpoint; its value is in this answer only. */
export async function POST(request: Request) {
  return handleCreateMcpKey(request, mcpKeysDeps());
}
