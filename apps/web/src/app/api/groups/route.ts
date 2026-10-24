import { handleCreate, handleList } from "../../../server/groups-api.ts";
import { groupsDeps } from "../../../server/groups-deps.ts";

export const dynamic = "force-dynamic";

/** The menu groups and which module sits in which. */
export async function GET(request: Request) {
  return handleList(request, groupsDeps());
}

/** A new menu group, last in the menu. */
export async function POST(request: Request) {
  return handleCreate(request, groupsDeps());
}
