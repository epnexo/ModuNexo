import type pg from "pg";

export type OperationKind = "install" | "upgrade" | "enable" | "disable" | "uninstall";
export type OperationStatus = "running" | "succeeded" | "failed" | "rolled_back";

export interface OperationRow {
  id: number;
  moduleId: string;
  version: string;
  /** The package an install or upgrade applies; null for a change of state. */
  sha256: string | null;
  kind: OperationKind;
  status: OperationStatus;
  step: string;
  detail: string | null;
  actor: string;
  pid: number;
  startedAt: Date;
  finishedAt: Date | null;
}

/** Another run is in progress; only one runs at a time. */
export class OperationBusyError extends Error {
  readonly running: OperationRow;
  constructor(running: OperationRow) {
    super(`another operation is running: ${running.kind} ${running.moduleId} ${running.version} (step "${running.step}", started ${running.startedAt.toISOString()})`);
    this.name = "OperationBusyError";
    this.running = running;
  }
}

const COLUMNS = "id, module_id, version, sha256, kind, status, step, detail, actor, pid, started_at, finished_at";

const toRow = (row: Record<string, unknown>): OperationRow => ({
  id: Number(row.id),
  moduleId: row.module_id as string,
  version: row.version as string,
  sha256: (row.sha256 as string | null) ?? null,
  kind: row.kind as OperationKind,
  status: row.status as OperationStatus,
  step: row.step as string,
  detail: (row.detail as string | null) ?? null,
  actor: row.actor as string,
  pid: Number(row.pid),
  startedAt: row.started_at as Date,
  finishedAt: (row.finished_at as Date | null) ?? null,
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and is somebody else's; only ESRCH means gone.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface StartOperation {
  moduleId: string;
  version: string;
  /** Required for an install or upgrade, and only for those. */
  sha256?: string;
  kind: OperationKind;
  actor: string;
  /** The process that does the work; defaults to this one. Only used to tell a dead run from a live one. */
  pid?: number;
}

/** Closes, as failed (interrupted), every `running` run whose process no longer exists; returns how many. */
export async function closeStaleOperations(pool: pg.Pool): Promise<number> {
  const running = (await pool.query(`select ${COLUMNS} from core.module_operations where status = 'running'`)).rows.map(toRow);
  let closed = 0;
  for (const run of running) {
    if (alive(run.pid)) continue;
    const { rowCount } = await pool.query(
      `update core.module_operations set status = 'failed', detail = 'interrupted: its process (' || pid || ') is gone', finished_at = now()
       where id = $1 and status = 'running'`,
      [run.id],
    );
    closed += rowCount ?? 0;
  }
  return closed;
}

/** The run that is in progress with a live process, if any. */
export async function liveOperation(pool: pg.Pool): Promise<OperationRow | undefined> {
  const running = (await pool.query(`select ${COLUMNS} from core.module_operations where status = 'running'`)).rows.map(toRow);
  return running.find((run) => alive(run.pid));
}

/**
 * Records the start of a run and returns its id. A run whose process no longer exists is first closed as failed
 * (interrupted); a run that is alive refuses this one with `OperationBusyError`.
 */
export async function startOperation(pool: pg.Pool, input: StartOperation): Promise<number> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await closeStaleOperations(pool);
    try {
      const { rows } = await pool.query(
        `insert into core.module_operations (module_id, version, sha256, kind, actor, pid) values ($1, $2, $3, $4, $5, $6) returning id`,
        [input.moduleId, input.version, input.sha256 ?? null, input.kind, input.actor, input.pid ?? process.pid],
      );
      return Number(rows[0].id);
    } catch (error) {
      if ((error as { code?: string }).code !== "23505") throw error;
      const running = await liveOperation(pool);
      if (running !== undefined) throw new OperationBusyError(running);
    }
  }
  throw new Error("could not start the operation: the running one keeps changing");
}

async function requireRunning(pool: pg.Pool, sql: string, params: unknown[]): Promise<void> {
  const { rowCount } = await pool.query(sql, params);
  if (rowCount === 0) throw new Error(`operation ${params[0]} is not running`);
}

export async function setStep(pool: pg.Pool, id: number, step: string, detail?: string): Promise<void> {
  await requireRunning(pool, "update core.module_operations set step = $2, detail = $3 where id = $1 and status = 'running'", [id, step, detail ?? null]);
}

export async function finishOperation(pool: pg.Pool, id: number, status: Exclude<OperationStatus, "running">, detail?: string): Promise<void> {
  await requireRunning(
    pool,
    "update core.module_operations set status = $2, detail = coalesce($3, detail), finished_at = now() where id = $1 and status = 'running'",
    [id, status, detail ?? null],
  );
}

/** Runs, newest first, optionally of one module. */
export async function listOperations(pool: pg.Pool, filter: { moduleId?: string; limit?: number } = {}): Promise<OperationRow[]> {
  const { rows } = await pool.query(
    `select ${COLUMNS} from core.module_operations where ($1::text is null or module_id = $1) order by id desc limit $2`,
    [filter.moduleId ?? null, filter.limit ?? 50],
  );
  return rows.map(toRow);
}
