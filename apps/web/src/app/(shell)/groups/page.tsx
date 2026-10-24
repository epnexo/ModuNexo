import type { Metadata } from "next";
import { GroupService } from "@modunexo/core/groups";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { GroupsManager } from "../../../components/groups/groups-manager";
import { modules as enabledManifests } from "../../../generated/modules";
import { platform } from "../../../server/platform";
import { resolveViewer } from "../../../server/viewer";

export const metadata: Metadata = { title: "Groups" };
export const dynamic = "force-dynamic";

export default async function GroupsPage() {
  const viewer = await resolveViewer(await headers());
  if (viewer === null) redirect("/login");

  if (!viewer.canWrite) {
    return (
      <div className="flex max-w-xl flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Groups</h1>
        <p className="text-muted">Only an administrator can manage groups.</p>
      </div>
    );
  }

  const { pool } = platform();
  const overview = await new GroupService(pool).overview();
  const installed = await pool.query("select id from core.modules order by id");
  const names = new Map(enabledManifests.map((manifest) => [manifest.id, manifest.name]));

  return (
    <div className="flex max-w-3xl flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Groups</h1>
        <p className="text-muted">Groups are the titled blocks of the sidebar. A module sits under the group you choose here; a module with none keeps the group its own manifest names, if any.</p>
      </div>
      <GroupsManager
        groups={overview.groups.map(({ id, name, moduleCount }) => ({ id, name, moduleCount }))}
        modules={installed.rows.map((row) => ({ id: row.id as string, name: names.get(row.id) ?? (row.id as string), groupId: overview.assignments[row.id] ?? null }))}
      />
    </div>
  );
}
