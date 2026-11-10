import { resolveMasterKey } from "@modunexo/core/auth";
import { DashboardService } from "@modunexo/core/dashboard";
import { JobService } from "@modunexo/core/jobs";
import { SettingsService } from "@modunexo/core/settings";
import { type DashboardView, buildDashboard } from "./dashboard.ts";
import { navigation } from "../generated/modules.ts";
import { subjectCan } from "./nav.ts";
import { platform } from "./platform.ts";
import { webRegistry } from "./registry.ts";
import { workerLine } from "./status.ts";
import type { Viewer } from "./viewer.ts";

/**
 * What the dashboard shows this viewer. Everyone gets the cards of the modules they may open; the platform's own
 * alerts, totals and activity are for an administrator, like the Status screen they point to.
 */
export async function loadDashboard(viewer: Viewer): Promise<DashboardView> {
  const { pool } = platform();
  const registry = webRegistry();
  const settings = new SettingsService(pool, registry, { masterKey: resolveMasterKey() });
  const service = new DashboardService(pool, registry, { incompleteSettings: (moduleId) => settings.incomplete(moduleId) });
  const [cards, overview, due] = await Promise.all([
    service.cards((_moduleId, permission) => subjectCan(viewer.subject, permission)),
    viewer.canWrite ? service.overview() : null,
    viewer.canWrite ? new JobService(pool, registry).dueWaiting() : null,
  ]);
  // A module has no icon of its own: its first menu entry that names one stands for it.
  const icons = new Map<string, string | undefined>();
  for (const entry of navigation) if (!icons.has(entry.moduleId) || icons.get(entry.moduleId) === undefined) icons.set(entry.moduleId, entry.icon);
  return buildDashboard({ cards, overview, icons, workerLine: due === null ? null : workerLine(due), now: new Date() });
}
