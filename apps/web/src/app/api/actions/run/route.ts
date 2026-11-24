import { actionsDeps } from "../../../../server/actions-deps.ts";
import { handleRunAction } from "../../../../server/actions-api.ts";

export const dynamic = "force-dynamic";

/** Runs an action by hand: a read answers with its rows, a write is the signed-in person's own decision and queues the module's job. */
export async function POST(request: Request) {
  return handleRunAction(request, actionsDeps());
}
