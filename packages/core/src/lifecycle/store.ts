import type pg from "pg";
import type { InstalledModule, LifecycleAction, ModuleStatusKind } from "./transitions.ts";

/** A pool or a single connection; the store works on either, so a caller can put several writes in one transaction. */
export type Queryable = Pick<pg.Pool, "query">;

export interface ModuleEvent {
  moduleId: string;
  action: LifecycleAction;
  fromState: ModuleStatusKind;
  toState: ModuleStatusKind;
  version: string;
  outcome: "ok" | "failed";
  /** The error message of a failure (prefixed by the failing step), or `keep` / `purge` for an uninstall; otherwise null. */
  detail?: string | null;
}

export interface RecordedEvent extends ModuleEvent {
  id: number;
  detail: string | null;
  occurredAt: Date;
}

/** Every row of `core.modules`, by module id. Empty before the core's lifecycle migration has run. */
export async function readStates(db: Queryable): Promise<Map<string, InstalledModule>> {
  const table = await db.query("select to_regclass('core.modules') is not null as present");
  if (!table.rows[0].present) return new Map();
  const { rows } = await db.query("select id, state, installed_version from core.modules order by id");
  return new Map(rows.map((row) => [row.id as string, { id: row.id, state: row.state, installedVersion: row.installed_version }]));
}

/** Insert the row or, when it exists, replace its state and version and move `updated_at`. `installed_at` stays. */
export async function upsertState(db: Queryable, module: InstalledModule): Promise<void> {
  await db.query(
    `insert into core.modules (id, state, installed_version) values ($1, $2, $3)
     on conflict (id) do update set state = excluded.state, installed_version = excluded.installed_version, updated_at = now()`,
    [module.id, module.state, module.installedVersion],
  );
}

export async function deleteState(db: Queryable, moduleId: string): Promise<void> {
  await db.query("delete from core.modules where id = $1", [moduleId]);
}

export async function appendEvent(db: Queryable, event: ModuleEvent): Promise<void> {
  await db.query(
    `insert into core.module_events (module_id, action, from_state, to_state, version, outcome, detail)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [event.moduleId, event.action, event.fromState, event.toState, event.version, event.outcome, event.detail ?? null],
  );
}

/** Events in the order they were recorded, for one module or for all of them. */
export async function readEvents(db: Queryable, moduleId?: string): Promise<RecordedEvent[]> {
  const { rows } = await db.query(
    `select id, module_id, action, from_state, to_state, version, outcome, detail, occurred_at
     from core.module_events where ($1::text is null or module_id = $1) order by id`,
    [moduleId ?? null],
  );
  return rows.map((row) => ({
    id: Number(row.id),
    moduleId: row.module_id,
    action: row.action,
    fromState: row.from_state,
    toState: row.to_state,
    version: row.version,
    outcome: row.outcome,
    detail: row.detail,
    occurredAt: row.occurred_at,
  }));
}

/** Names of the schemas that exist in the database, to tell whether a module's data is still there. */
export async function readSchemas(db: Queryable): Promise<Set<string>> {
  const { rows } = await db.query("select schema_name from information_schema.schemata");
  return new Set(rows.map((row) => row.schema_name as string));
}
