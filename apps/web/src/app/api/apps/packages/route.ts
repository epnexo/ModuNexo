import { handleUpload } from "../../../../server/apps-api.ts";
import { appsDeps } from "../../../../server/apps-deps.ts";

export const dynamic = "force-dynamic";

/** Receives a module archive (the raw request body) and stages it for review; nothing is installed. */
export async function POST(request: Request) {
  return handleUpload(request, appsDeps());
}
