import { handleAssign } from "../../../../server/groups-api.ts";
import { groupsDeps } from "../../../../server/groups-deps.ts";

export const dynamic = "force-dynamic";

/** Puts an installed module in a menu group, or takes it out of its group. */
export async function POST(request: Request) {
  return handleAssign(request, groupsDeps());
}
