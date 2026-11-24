import { actionsDeps } from "../../../../../../server/actions-deps.ts";
import { handleApprove } from "../../../../../../server/actions-api.ts";
import { parseTokenId } from "../../../../../../server/module-tokens-api.ts";

export const dynamic = "force-dynamic";

/** Approve a proposal an agent left waiting. The id is digits only; anything else is no proposal. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleApprove(request, parseTokenId((await context.params).id), actionsDeps());
}
