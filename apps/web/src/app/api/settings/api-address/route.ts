import { handleSetAddress } from "../../../../server/module-tokens-api.ts";
import { apiAccessDeps } from "../../../../server/module-tokens-deps.ts";

export const dynamic = "force-dynamic";

/** The address shown to API clients; `{ address: null }` goes back to the platform's own. */
export async function PUT(request: Request) {
  return handleSetAddress(request, apiAccessDeps());
}
