import { handleState } from "../../../server/apps-api.ts";
import { appsDeps } from "../../../server/apps-deps.ts";

export const dynamic = "force-dynamic";

/** The runs and received packages the Apps screen polls. Administrators only. */
export async function GET(request: Request) {
  return handleState(request, appsDeps());
}
