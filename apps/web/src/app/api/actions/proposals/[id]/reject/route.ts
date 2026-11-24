import { actionsDeps } from "../../../../../../server/actions-deps.ts";
import { handleReject } from "../../../../../../server/actions-api.ts";
import { parseTokenId } from "../../../../../../server/module-tokens-api.ts";

export const dynamic = "force-dynamic";

/** Reject a proposal an agent left waiting. The id is digits only; anything else is no proposal. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleReject(request, parseTokenId((await context.params).id), actionsDeps());
}
