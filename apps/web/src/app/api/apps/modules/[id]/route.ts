import { handleChange } from "../../../../../server/apps-api.ts";
import { appsDeps } from "../../../../../server/apps-deps.ts";

export const dynamic = "force-dynamic";

/** Enable, disable or uninstall an installed module, with a rebuild. Starts it and answers at once. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return handleChange(request, appsDeps(), id);
}
