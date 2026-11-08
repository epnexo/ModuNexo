import { handleRegenerateToken, parseTokenId } from "../../../../../../../../server/module-tokens-api.ts";
import { apiAccessDeps } from "../../../../../../../../server/module-tokens-deps.ts";

export const dynamic = "force-dynamic";

/** A new token in place of this one, which is revoked; the new value is in this answer only. */
export async function POST(request: Request, context: { params: Promise<{ id: string; tokenId: string }> }) {
  const { id, tokenId } = await context.params;
  return handleRegenerateToken(request, id, parseTokenId(tokenId), apiAccessDeps());
}
