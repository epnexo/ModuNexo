import type { DashboardSeverity } from "@modunexo/sdk";
import type pg from "pg";
import { CORE_MODULE_ID } from "../core-module.ts";
import { ModuleDbService } from "../data/module-db.ts";
import { type Logger, log as platformLog } from "../log.ts";
import type { Registry } from "../registry.ts";

/** Longest a declared statement may run, so one slow module cannot hold the dashboard. */
const DEFAULT_TIMEOUT_MS = 3000;
const MAX_TEXT_CHARS = 60;
/** How far back a stopped job or a failed operation still raises an alert. */
const RECENT = "7 days";
const SEVERITY_RANK: Record<DashboardSeverity, number> = { error: 0, warning: 1, info: 2 };

export interface DashboardOptions {
  /** Default 3 s. */
  statementTimeoutMs?: number;
  /** Keys of the required settings a module still lacks; the web passes the settings service's `incomplete`. */
  incompleteSettings?: (moduleId: string) => Promise<string[]>;
  /** Where a failed statement is reported, for whoever reads the server's output. Default: the platform's log. */
  log?: Logger;
}

interface CardBase {
  moduleId: string;
  moduleName: string;
  key: string;
  label: string;
  href: string;
}

/** `value` is null when the figure could not be read: the statement failed, was slow, wrote, or answered with something that is not a figure. */
export interface StatCard extends CardBase {
  value: number | string | null;
}

/** `count` is null when it could not be read; an alert whose count is 0 is not listed at all. */
export interface AlertCard extends CardBase {
  severity: DashboardSeverity;
  count: number | null;
}

export interface ModuleCards {
  stats: StatCard[];
  alerts: AlertCard[];
  /** Enabled modules that contribute nothing to the dashboard. */
  silent: { moduleId: string; moduleName: string }[];
}

export interface PlatformAlert {
  kind: "job_dead" | "operation_failed" | "settings_incomplete";
  severity: DashboardSeverity;
  moduleId: string;
  /** Names the module and the job or operation. Never carries an error text or a setting's key. */
  label: string;
  href: string;
  count: number;
  at: Date | null;
}

export interface ActivityEntry {
  at: Date;
  moduleId: string;
  text: string;
  href: string;
}

export interface PlatformOverview {
  modules: { enabled: number; disabled: number };
  jobs: { queued: number; running: number };
  alerts: PlatformAlert[];
  activity: ActivityEntry[];
}

/** A whole number the database sent as a number or, for `bigint`, as a string. */
function wholeNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : null;
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : null;
  }
  return null;
}

function toStat(value: unknown): number | string | null {
  const number = wholeNumber(value);
  if (number !== null) return number;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && value.length <= MAX_TEXT_CHARS) return value;
  return null;
}

function toCount(value: unknown): number | null {
  const number = wholeNumber(value);
  return number !== null && number >= 0 ? number : null;
}

/**
 * What the dashboard shows. A module's figures come from statements it declares in its manifest; each runs in a
 * `READ ONLY` transaction on the module's own schema with a short time limit, and a statement that fails is reported
 * as "not available" without the database's message. Nothing here returns an error text, a payload or a setting's key.
 */
export class DashboardService {
  readonly #db: ModuleDbService;

  constructor(
    private readonly pool: pg.Pool,
    private readonly registry: Registry,
    private readonly options: DashboardOptions = {},
  ) {
    this.#db = new ModuleDbService(pool, registry, { statementTimeoutMs: options.statementTimeoutMs ?? DEFAULT_TIMEOUT_MS });
  }

  async #enabledIds(): Promise<string[]> {
    const { rows } = await this.pool.query("select id from core.modules where state = 'enabled' order by id");
    return (rows as { id: string }[]).map((row) => row.id).filter((id) => id !== CORE_MODULE_ID && this.registry.get(id) !== undefined);
  }

  async #first(moduleId: string, card: string, sql: string): Promise<unknown> {
    try {
      const result = await this.#db.readOwn(moduleId).query(sql);
      const row = result.rows[0];
      return row === undefined ? undefined : Object.values(row)[0];
    } catch (error) {
      // The card says "not available" and nothing more; the reason goes to the server's log, where only an operator reads it.
      (this.options.log ?? platformLog).warn("dashboard.statement_failed", { module: moduleId, card, error });
      return undefined;
    }
  }

  /** The figures and alerts of the enabled modules, leaving out what `canSee` refuses for a permission. */
  async cards(canSee: (moduleId: string, permission: string | undefined) => boolean): Promise<ModuleCards> {
    const stats: Promise<StatCard>[] = [];
    const alerts: Promise<AlertCard | null>[] = [];
    const silent: ModuleCards["silent"] = [];
    for (const id of await this.#enabledIds()) {
      const manifest = this.registry.get(id)!;
      const dashboard = manifest.dashboard;
      if (dashboard === undefined) {
        silent.push({ moduleId: id, moduleName: manifest.name });
        continue;
      }
      const base = (entry: { key: string; label: string; href: string }): CardBase => ({ moduleId: id, moduleName: manifest.name, key: entry.key, label: entry.label, href: entry.href });
      for (const stat of dashboard.stats ?? []) {
        if (!canSee(id, stat.permission)) continue;
        stats.push(this.#first(id, stat.key, stat.sql).then((value) => ({ ...base(stat), value: toStat(value) })));
      }
      for (const alert of dashboard.alerts ?? []) {
        if (!canSee(id, alert.permission)) continue;
        alerts.push(
          this.#first(id, alert.key, alert.sql).then((value) => {
            const count = toCount(value);
            return count === 0 ? null : { ...base(alert), severity: alert.severity, count };
          }),
        );
      }
    }
    const shown = (await Promise.all(alerts)).filter((alert): alert is AlertCard => alert !== null);
    shown.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
    return { stats: await Promise.all(stats), alerts: shown, silent };
  }

  /** The platform's own state: module and job totals, what needs a look, and the newest activity. */
  async overview(): Promise<PlatformOverview> {
    const [moduleRows, jobRows, dead, failed, events, operations, settings] = await Promise.all([
      this.pool.query("select state, count(*)::int as n from core.modules group by state"),
      this.pool.query("select status, count(*)::int as n from core.jobs where status in ('queued', 'running') group by status"),
      this.pool.query(
        `select module_id, name, count(*)::int as n, max(finished_at) as at from core.jobs
         where status = 'dead' and finished_at > now() - interval '${RECENT}' group by module_id, name order by max(finished_at) desc limit 20`,
      ),
      this.pool.query(
        `select module_id, version, kind, status, finished_at from core.module_operations
         where status in ('failed', 'rolled_back') and finished_at > now() - interval '${RECENT}' order by finished_at desc limit 10`,
      ),
      this.pool.query("select module_id, type, created_at from core.events order by id desc limit 10"),
      this.pool.query("select module_id, version, kind, status, coalesce(finished_at, started_at) as at from core.module_operations order by id desc limit 5"),
      this.#incomplete(),
    ]);
    const count = (rows: { n: number; state?: string; status?: string }[], key: "state" | "status", value: string) => rows.find((row) => row[key] === value)?.n ?? 0;
    const alerts: PlatformAlert[] = [];
    for (const row of dead.rows as { module_id: string; name: string; n: number; at: Date }[]) {
      alerts.push({
        kind: "job_dead",
        severity: "error",
        moduleId: row.module_id,
        label: `Job "${row.name}" of ${row.module_id} stopped after its last attempt`,
        href: "/status",
        count: row.n,
        at: row.at,
      });
    }
    for (const row of failed.rows as { module_id: string; version: string; kind: string; status: string; finished_at: Date }[]) {
      alerts.push({
        kind: "operation_failed",
        severity: "error",
        moduleId: row.module_id,
        label: `${row.kind === "install" ? "Install" : "Upgrade"} of ${row.module_id} ${row.version} ${row.status === "failed" ? "failed" : "was rolled back"}`,
        href: "/apps",
        count: 1,
        at: row.finished_at,
      });
    }
    for (const { moduleId, moduleName, missing } of settings) {
      alerts.push({
        kind: "settings_incomplete",
        severity: "warning",
        moduleId,
        label: `${moduleName} still needs ${missing} required ${missing === 1 ? "setting" : "settings"}`,
        href: "/settings",
        count: missing,
        at: null,
      });
    }
    const activity: ActivityEntry[] = [
      ...(events.rows as { module_id: string; type: string; created_at: Date }[]).map((row) => ({ at: row.created_at, moduleId: row.module_id, text: row.type, href: "/status" })),
      ...(operations.rows as { module_id: string; version: string; kind: string; status: string; at: Date }[]).map((row) => ({
        at: row.at,
        moduleId: row.module_id,
        text: `${row.kind === "install" ? "Install" : "Upgrade"} of ${row.module_id} ${row.version}: ${row.status}`,
        href: "/apps",
      })),
    ]
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, 15);
    return {
      modules: { enabled: count(moduleRows.rows, "state", "enabled"), disabled: count(moduleRows.rows, "state", "disabled") },
      jobs: { queued: count(jobRows.rows, "status", "queued"), running: count(jobRows.rows, "status", "running") },
      alerts,
      activity,
    };
  }

  async #incomplete(): Promise<{ moduleId: string; moduleName: string; missing: number }[]> {
    const ask = this.options.incompleteSettings;
    if (ask === undefined) return [];
    const found = await Promise.all(
      (await this.#enabledIds()).map(async (moduleId) => {
        try {
          return { moduleId, moduleName: this.registry.get(moduleId)!.name, missing: (await ask(moduleId)).length };
        } catch {
          return { moduleId, moduleName: moduleId, missing: 0 };
        }
      }),
    );
    return found.filter((entry) => entry.missing > 0);
  }
}
