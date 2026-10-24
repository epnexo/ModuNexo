import { groupIdFrom, handleRemove, handleUpdate } from "../../../../server/groups-api.ts";
import { groupsDeps } from "../../../../server/groups-deps.ts";

export const dynamic = "force-dynamic";

const notFound = () => Response.json({ error: "That group does not exist." }, { status: 404, headers: { "cache-control": "no-store" } });

/** Renames a menu group, moves it, or both. */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const id = groupIdFrom((await context.params).id);
  return id === null ? notFound() : handleUpdate(request, id, groupsDeps());
}

/** Deletes a menu group; its modules stay installed. */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const id = groupIdFrom((await context.params).id);
  return id === null ? notFound() : handleRemove(request, id, groupsDeps());
}
