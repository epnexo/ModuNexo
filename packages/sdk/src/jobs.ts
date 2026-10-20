/**
 * How a module's code works with background jobs. A job is a function in the module's folder that the platform's
 * worker process runs: the module declares it in its manifest and enqueues runs of it with `enqueueJob`. Like
 * settings, the enqueuer is reached through a global symbol that the platform registers (the web app and the
 * worker do), so the SDK stays free of database code and every copy of it finds the same one.
 */
export const JOBS_ENQUEUER: unique symbol = Symbol.for("modunexo.jobs.enqueuer") as never;

/** What a job handler receives. */
export interface JobContext {
  moduleId: string;
  /** The job's declared name. */
  jobName: string;
  jobId: number;
  /** 1 on the first run, then 2 for the first retry, and so on. */
  attempt: number;
  /** What was passed to `enqueueJob`; null when nothing was. A scheduled run has no payload. */
  payload: unknown;
  /** Aborts when the declared `timeoutSeconds` pass. A handler that does not watch it keeps running but is marked failed. */
  signal: AbortSignal;
}

/** The default export of a job's `entry` file. Throwing, or rejecting, fails the attempt. */
export type JobHandler = (context: JobContext) => void | Promise<void>;

export interface EnqueueOptions {
  /** Do not run before this time. Default: now. Not combined with `delaySeconds`. */
  runAt?: Date;
  /** Do not run before this many seconds from now. Not combined with `runAt`. */
  delaySeconds?: number;
  /**
   * While a job of the same module and name with this key is queued or running, enqueueing again returns that job
   * instead of adding another.
   */
  dedupeKey?: string;
}

export interface EnqueueResult {
  id: number;
  /** True when an active job with the same `dedupeKey` was returned instead of a new one. */
  deduplicated: boolean;
}

export interface JobsEnqueuer {
  enqueue(moduleId: string, name: string, payload: unknown, options: EnqueueOptions): Promise<EnqueueResult>;
}

/** `enqueueJob` ran where the platform has not registered an enqueuer: a script, a test, a build step. */
export class JobsUnavailableError extends Error {
  constructor() {
    super("jobs can only be enqueued while the platform is running: no jobs enqueuer is registered in this process");
    this.name = "JobsUnavailableError";
  }
}

/**
 * Queue a run of one of the module's declared jobs. The module must be enabled and have declared the job; the
 * payload must be JSON and at most 64 KiB. Rejects with the platform's reason when it refuses.
 */
export async function enqueueJob(moduleId: string, name: string, payload?: unknown, options: EnqueueOptions = {}): Promise<EnqueueResult> {
  const enqueuer = (globalThis as typeof globalThis & { [JOBS_ENQUEUER]?: JobsEnqueuer })[JOBS_ENQUEUER];
  if (enqueuer === undefined) throw new JobsUnavailableError();
  return enqueuer.enqueue(moduleId, name, payload ?? null, options);
}

const INTERVAL = /^([1-9]\d*)([smhd])$/;
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
export const MIN_INTERVAL_MS = 10_000;
export const MAX_INTERVAL_MS = 30 * 86_400_000;

/** `"30s"`, `"5m"`, `"2h"`, `"1d"` as milliseconds, or null when it is anything else or outside 10 seconds to 30 days. */
export function parseInterval(text: unknown): number | null {
  if (typeof text !== "string") return null;
  const match = INTERVAL.exec(text);
  if (match === null) return null;
  const ms = Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
  return Number.isSafeInteger(ms) && ms >= MIN_INTERVAL_MS && ms <= MAX_INTERVAL_MS ? ms : null;
}
