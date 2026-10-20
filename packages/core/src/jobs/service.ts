import type pg from "pg";
import type { EnqueueOptions, EnqueueResult } from "@modunexo/sdk";
import type { Registry } from "../registry.ts";
import type { Executor } from "../executor.ts";
import { JobError } from "./errors.ts";

export type JobStatus = "queued" | "running" | "succeeded" | "dead" | "cancelled";
export const JOB_STATUSES: readonly JobStatus[] = ["queued", "running", "succeeded", "dead", "cancelled"];

/** A job as the platform lists it. The payload is read apart, because it may hold what the module put there. */
export interface JobRecord {
  id: number;
  moduleId: string;
  name: string;
  status: JobStatus;
  runAt: Date;
  attempts: number;
  maxAttempts: number;
  timeoutSeconds: number;
  lastError: string | null;
  dedupeKey: string | null;
  enqueuedBy: string;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  payload?: unknown;
}

/** A job a worker has claimed, with what it needs to run it and to report the outcome. */
export interface ClaimedJob {
  id: number;
  moduleId: string;
  name: string;
  payload: unknown;
  attempt: number;
  maxAttempts: number;
  timeoutSeconds: number;
}

/** A job that repeats: the worker keeps exactly one active run of it. */
export interface ScheduledJob {
  moduleId: string;
  name: string;
  everyMs: number;
  timeoutSeconds: number;
  maxAttempts: number;
}

export const DEFAULT_TIMEOUT_SECONDS = 60;
export const DEFAULT_MAX_ATTEMPTS = 5;
/** A lease outlives the job's timeout by this long, so a handler that is stopped on time is never recovered by mistake. */
export const LEASE_GRACE_SECONDS = 30;
export const MAX_PAYLOAD_BYTES = 64 * 1024;
export const MAX_ERROR_CHARS = 1000;
export const FINISHED_RETENTION_DAYS = 14;
/** The reserved dedupe key of the single next run of a job that repeats. A module's own keys cannot look like it. */
export const SCHEDULE_KEY = "~schedule";
const MAX_DELAY_SECONDS = 30 * 86_400;
const DEDUPE_KEY = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,99}$/;
const RETRY_BASE_MS = 10_000;
const RETRY_CAP_MS = 3_600_000;
const ENQUEUE_ATTEMPTS = 3;
/** Postgres: a value jsonb cannot hold (a NUL in a string). */
const UNTRANSLATABLE_CHARACTER = "22P05";
const UNIQUE_VIOLATION = "23505";

/** How long to wait after attempt `attempt` failed: 10 s, doubling, at most an hour. */
export const retryDelayMs = (attempt: number): number => Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1), RETRY_CAP_MS);

const ROW = `id, module_id, name, status, run_at, attempts, max_attempts, timeout_seconds, last_error, dedupe_key, enqueued_by, created_at, started_at, finished_at`;

function toRecord(row: Record<string, unknown>): JobRecord {
  return {
    id: Number(row.id),
    moduleId: row.module_id as string,
    name: row.name as string,
    status: row.status as JobStatus,
    runAt: row.run_at as Date,
    attempts: row.attempts as number,
    maxAttempts: row.max_attempts as number,
    timeoutSeconds: row.timeout_seconds as number,
    lastError: (row.last_error as string | null) ?? null,
    dedupeKey: (row.dedupe_key as string | null) ?? null,
    enqueuedBy: row.enqueued_by as string,
    createdAt: row.created_at as Date,
    startedAt: (row.started_at as Date | null) ?? null,
    finishedAt: (row.finished_at as Date | null) ?? null,
    ...("payload" in row ? { payload: row.payload } : {}),
  };
}

/** The message of an error, cut so one failure cannot fill the table. */
export const errorText = (error: unknown): string => {
  const text = error instanceof Error ? error.message || error.name : String(error);
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS - 1)}…` : text;
};

export interface JobServiceOptions {
  now?: () => Date;
}

/** The queue: enqueue, claim, finish, retry, recover, schedule, list. Every state change is one guarded statement. */
export class JobService {
  private readonly now: () => Date;

  constructor(
    private readonly pool: pg.Pool,
    private readonly registry: Registry,
    options: JobServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Queue a run of a job the module declared. The module has to be enabled. With `executor` (a client in a transaction)
   * the job is queued in that transaction and exists only if it commits.
   */
  async enqueue(moduleId: string, name: string, payload: unknown, options: EnqueueOptions = {}, enqueuedBy = "module", executor?: Executor): Promise<EnqueueResult> {
    const db: Executor = executor ?? this.pool;
    const manifest = this.registry.get(moduleId);
    if (manifest === undefined) throw new JobError(`module "${moduleId}" is not registered`);
    const job = (manifest.jobs ?? []).find((candidate) => candidate.name === name);
    if (job === undefined) {
      const declared = (manifest.jobs ?? []).map((candidate) => candidate.name);
      throw new JobError(`module "${moduleId}" does not declare the job "${name}"${declared.length === 0 ? " (it declares none)" : ` (declared: ${declared.sort().join(", ")})`}`);
    }
    const enabled = await db.query("select 1 from core.modules where id = $1 and state = 'enabled'", [moduleId]);
    if (enabled.rowCount === 0) throw new JobError(`module "${moduleId}" is not enabled`);

    let json: string;
    try {
      json = JSON.stringify(payload === undefined ? null : payload) ?? "null";
    } catch {
      throw new JobError("the payload must be JSON: it cannot be serialised");
    }
    if (Buffer.byteLength(json) > MAX_PAYLOAD_BYTES) throw new JobError(`the payload is over ${MAX_PAYLOAD_BYTES / 1024} KiB`);
    if (options.runAt !== undefined && options.delaySeconds !== undefined) throw new JobError("runAt and delaySeconds cannot be combined");
    const now = this.now();
    let runAt = now;
    if (options.runAt !== undefined) {
      if (!(options.runAt instanceof Date) || Number.isNaN(options.runAt.getTime())) throw new JobError("runAt must be a valid date");
      runAt = options.runAt;
    }
    if (options.delaySeconds !== undefined) {
      if (!Number.isFinite(options.delaySeconds) || options.delaySeconds < 0 || options.delaySeconds > MAX_DELAY_SECONDS) {
        throw new JobError(`delaySeconds must be from 0 to ${MAX_DELAY_SECONDS}`);
      }
      runAt = new Date(now.getTime() + options.delaySeconds * 1000);
    }
    const key = options.dedupeKey;
    if (key !== undefined && !DEDUPE_KEY.test(key)) {
      throw new JobError("dedupeKey must be 1 to 100 characters: letters, digits and : . _ -, starting with a letter or digit");
    }

    for (let attempt = 0; attempt < ENQUEUE_ATTEMPTS; attempt++) {
      let inserted: Awaited<ReturnType<Executor["query"]>>;
      try {
        inserted = await db.query(
          `insert into core.jobs (module_id, name, payload, run_at, max_attempts, timeout_seconds, dedupe_key, enqueued_by)
           values ($1, $2, $3::jsonb, $4, $5, $6, $7, $8)
           on conflict (module_id, name, dedupe_key) where dedupe_key is not null and status in ('queued', 'running') do nothing
           returning id`,
          [moduleId, name, json, runAt, job.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, job.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS, key ?? null, enqueuedBy],
        );
      } catch (error) {
        // JSON can carry a NUL character in a string; jsonb cannot store it.
        if ((error as { code?: string }).code === UNTRANSLATABLE_CHARACTER) throw new JobError("the payload cannot be stored: a string in it holds the character \\u0000");
        throw error;
      }
      if (inserted.rowCount === 1) return { id: Number(inserted.rows[0]!.id), deduplicated: false };
      // The key is taken by an active job. If it finished since, the next pass inserts.
      const existing = await db.query(
        "select id from core.jobs where module_id = $1 and name = $2 and dedupe_key = $3 and status in ('queued', 'running')",
        [moduleId, name, key],
      );
      if (existing.rowCount === 1) return { id: Number(existing.rows[0]!.id), deduplicated: true };
    }
    throw new JobError("could not enqueue the job; try again");
  }

  /** Claims up to `limit` due jobs of the given modules for `workerId`. Each claim is an attempt and takes a lease. */
  async claim(workerId: string, limit: number, moduleIds: string[]): Promise<ClaimedJob[]> {
    if (limit <= 0 || moduleIds.length === 0) return [];
    const claimed = await this.pool.query(
      `with due as (
         select id from core.jobs
         where status = 'queued' and run_at <= $1::timestamptz and module_id = any($2::text[])
         order by run_at, id
         limit $3
         for update skip locked
       )
       update core.jobs j
       set status = 'running', attempts = j.attempts + 1, locked_by = $4, started_at = $1::timestamptz,
           lease_until = $1::timestamptz + make_interval(secs => j.timeout_seconds + $5), finished_at = null
       from due
       where j.id = due.id
       returning j.id, j.module_id, j.name, j.payload, j.attempts, j.max_attempts, j.timeout_seconds`,
      [this.now(), moduleIds, limit, workerId, LEASE_GRACE_SECONDS],
    );
    return claimed.rows
      .map((row) => ({
        id: Number(row.id),
        moduleId: row.module_id as string,
        name: row.name as string,
        payload: row.payload,
        attempt: row.attempts as number,
        maxAttempts: row.max_attempts as number,
        timeoutSeconds: row.timeout_seconds as number,
      }))
      .sort((a, b) => a.id - b.id);
  }

  /** Marks a claimed job done. False when the job is no longer this attempt's to finish (its lease was lost). */
  async complete(job: ClaimedJob, workerId: string): Promise<boolean> {
    const done = await this.pool.query(
      `update core.jobs set status = 'succeeded', finished_at = $4::timestamptz, lease_until = null, locked_by = null, last_error = null
       where id = $1 and status = 'running' and locked_by = $2 and attempts = $3`,
      [job.id, workerId, job.attempt, this.now()],
    );
    return done.rowCount === 1;
  }

  /** Records a failed attempt: back to the queue after a delay, or dead when the attempts are spent. 'lost' as for `complete`. */
  async fail(job: ClaimedJob, workerId: string, error: unknown): Promise<"retry" | "dead" | "lost"> {
    const now = this.now();
    const dead = job.attempt >= job.maxAttempts;
    const retryAt = new Date(now.getTime() + retryDelayMs(job.attempt));
    const failed = await this.pool.query(
      `update core.jobs
       set status = $4, run_at = $5::timestamptz, finished_at = $6::timestamptz, lease_until = null, locked_by = null, last_error = $7
       where id = $1 and status = 'running' and locked_by = $2 and attempts = $3
       returning status`,
      [job.id, workerId, job.attempt, dead ? "dead" : "queued", dead ? now : retryAt, dead ? now : null, errorText(error)],
    );
    if (failed.rowCount !== 1) return "lost";
    return dead ? "dead" : "retry";
  }

  /** Gives back the jobs of workers that died: queued again, or dead when that was their last attempt. */
  async recoverExpired(): Promise<number> {
    const now = this.now();
    const recovered = await this.pool.query(
      `update core.jobs
       set status = case when attempts >= max_attempts then 'dead' else 'queued' end,
           run_at = $1::timestamptz,
           finished_at = case when attempts >= max_attempts then $1::timestamptz else null end,
           lease_until = null, locked_by = null,
           last_error = 'the worker stopped before the job finished (its lease expired)'
       where status = 'running' and lease_until < $1::timestamptz`,
      [now],
    );
    return recovered.rowCount ?? 0;
  }

  /**
   * Makes sure each scheduled job has exactly one active run. With none active, the next is queued `every` after the
   * last scheduled run finished, or now when it never ran. Two workers doing this at once cannot add two: the dedupe
   * index lets one insert win.
   */
  async ensureSchedules(schedules: ScheduledJob[]): Promise<number> {
    const now = this.now();
    let added = 0;
    for (const s of schedules) {
      const result = await this.pool.query(
        `insert into core.jobs (module_id, name, run_at, max_attempts, timeout_seconds, dedupe_key, enqueued_by)
         select $1::text, $2::text,
                coalesce((select max(finished_at) from core.jobs where module_id = $1::text and name = $2::text and dedupe_key = $3::text) + make_interval(secs => $4::double precision / 1000), $5::timestamptz),
                $6::integer, $7::integer, $3::text, 'schedule'
         on conflict (module_id, name, dedupe_key) where dedupe_key is not null and status in ('queued', 'running') do nothing`,
        [s.moduleId, s.name, SCHEDULE_KEY, s.everyMs, now, s.maxAttempts, s.timeoutSeconds],
      );
      added += result.rowCount ?? 0;
    }
    return added;
  }

  async list(filter: { moduleId?: string; status?: JobStatus; limit?: number; payload?: boolean } = {}): Promise<JobRecord[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.moduleId !== undefined) where.push(`module_id = $${params.push(filter.moduleId)}`);
    if (filter.status !== undefined) where.push(`status = $${params.push(filter.status)}`);
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 1000);
    const result = await this.pool.query(
      `select ${ROW}${filter.payload === true ? ", payload" : ""} from core.jobs ${where.length === 0 ? "" : `where ${where.join(" and ")}`} order by id desc limit ${limit}`,
      params,
    );
    return result.rows.map(toRecord);
  }

  /** Cancels a job that has not started. */
  async cancel(id: number): Promise<JobRecord> {
    const cancelled = await this.pool.query(
      `update core.jobs set status = 'cancelled', finished_at = $2::timestamptz where id = $1 and status = 'queued' returning ${ROW}`,
      [id, this.now()],
    );
    if (cancelled.rowCount === 1) return toRecord(cancelled.rows[0]);
    throw await this.refusal(id, "only a queued job can be cancelled");
  }

  /** Puts a dead job back in the queue with its attempts reset. */
  async retry(id: number): Promise<JobRecord> {
    let retried: pg.QueryResult;
    try {
      retried = await this.pool.query(
        `update core.jobs set status = 'queued', attempts = 0, run_at = $2::timestamptz, finished_at = null where id = $1 and status = 'dead' returning ${ROW}`,
        [id, this.now()],
      );
    } catch (error) {
      if ((error as { code?: string }).code !== UNIQUE_VIOLATION) throw error;
      // The dead job's dedupe key was taken since (the next scheduled run, or a job enqueued with the same key).
      const holder = await this.pool.query(
        `select active.id from core.jobs dead join core.jobs active
           on active.module_id = dead.module_id and active.name = dead.name and active.dedupe_key = dead.dedupe_key and active.status in ('queued', 'running')
         where dead.id = $1 limit 1`,
        [id],
      );
      const other = holder.rowCount === 1 ? ` (job ${holder.rows[0].id})` : "";
      throw new JobError(`job ${id} cannot be retried: another job${other} holds its dedupe key`);
    }
    if (retried.rowCount === 1) return toRecord(retried.rows[0]);
    throw await this.refusal(id, "only a dead job can be retried");
  }

  private async refusal(id: number, rule: string): Promise<JobError> {
    const found = await this.pool.query("select status from core.jobs where id = $1", [id]);
    if (found.rowCount === 0) return new JobError(`there is no job ${id}`);
    return new JobError(`job ${id} is ${found.rows[0].status}: ${rule}`);
  }

  /** Deletes finished jobs older than the retention. Returns how many. */
  async prune(): Promise<number> {
    const cutoff = new Date(this.now().getTime() - FINISHED_RETENTION_DAYS * 86_400_000);
    const pruned = await this.pool.query("delete from core.jobs where finished_at is not null and finished_at < $1::timestamptz", [cutoff]);
    return pruned.rowCount ?? 0;
  }
}
