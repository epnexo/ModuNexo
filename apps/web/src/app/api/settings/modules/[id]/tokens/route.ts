import { handleCreateToken, handleListTokens } from "../../../../../../server/module-tokens-api.ts";
import { apiAccessDeps } from "../../../../../../server/module-tokens-deps.ts";

export const dynamic = "force-dynamic";

/** The module's service tokens: names, prefixes, scopes and dates, never a token value. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleListTokens(request, (await context.params).id, apiAccessDeps());
}

/** A new service token for the module; its value is in this answer only. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleCreateToken(request, (await context.params).id, apiAccessDeps());
}
