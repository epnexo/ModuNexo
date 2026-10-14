import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppsManager, type AppsState, type InstalledModule } from "../../../components/apps/apps-manager";
import { modules } from "../../../generated/modules";
import { appsDeps } from "../../../server/apps-deps";
import { platform } from "../../../server/platform";
import { resolveViewer } from "../../../server/viewer";

export const metadata: Metadata = { title: "Apps" };
export const dynamic = "force-dynamic";

export default async function AppsPage() {
  const viewer = await resolveViewer(await headers());
  if (viewer === null) redirect("/login");

  const list = (
    <section aria-labelledby="built-heading" className="flex flex-col gap-3">
      <h2 id="built-heading" className="text-lg font-semibold tracking-tight">
        In this build
      </h2>
      {modules.length === 0 ? (
        <p className="text-muted">No modules are enabled in this build.</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
          {modules.map((module) => (
            <li key={module.id} className="flex items-baseline justify-between gap-4 px-4 py-3">
              <span className="font-medium">{module.name}</span>
              <span className="text-sm text-muted" data-numeric>
                {module.id} · {module.version}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );

  let manager = null;
  if (viewer.canWrite) {
    const { pool } = platform();
    const initial = (await appsDeps().state()) as unknown as AppsState;
    const rows = (await pool.query("select id, state, installed_version from core.modules order by id")).rows as { id: string; state: "enabled" | "disabled"; installed_version: string }[];
    const names = new Map(modules.map((module) => [module.id, module.name]));
    const installedModules: InstalledModule[] = rows.map((row) => ({ id: row.id, name: names.get(row.id) ?? row.id, version: row.installed_version, state: row.state }));
    manager = <AppsManager initial={initial} installed={Object.fromEntries(rows.map((row) => [row.id, row.installed_version]))} modules={installedModules} />;
  }

  return (
    <div className="flex max-w-3xl flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Apps</h1>
        <p className="text-muted">The modules this build was generated with{viewer.canWrite ? ", and the packages you add." : "."}</p>
      </div>
      {manager}
      {list}
      {viewer.canWrite ? null : <p className="text-sm text-muted">Only an administrator can add, enable, disable or uninstall modules.</p>}
    </div>
  );
}
