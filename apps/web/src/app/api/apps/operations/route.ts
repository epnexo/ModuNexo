import { handleStart } from "../../../../server/apps-api.ts";
import { appsDeps } from "../../../../server/apps-deps.ts";

export const dynamic = "force-dynamic";

/** Starts the install or upgrade of a staged package as a detached process and answers at once. */
export async function POST(request: Request) {
  return handleStart(request, appsDeps());
}
