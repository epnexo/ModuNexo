import { handleRevokeToken, parseTokenId } from "../../../../../../../server/module-tokens-api.ts";
import { apiAccessDeps } from "../../../../../../../server/module-tokens-deps.ts";

export const dynamic = "force-dynamic";

/** Stops one service token from working at once. */
export async function DELETE(request: Request, context: { params: Promise<{ id: string; tokenId: string }> }) {
  const { id, tokenId } = await context.params;
  return handleRevokeToken(request, id, parseTokenId(tokenId), apiAccessDeps());
}
