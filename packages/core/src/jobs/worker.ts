import { DEFAULT_MAX_ATTEMPTS, DEFAULT_TIMEOUT_SECONDS, type ClaimedJob, type JobService, type ScheduledJob } from "./service.ts";
import { type JobContext, type JobHandler, type ModuleManifest, parseInterval } from "@modunexo/sdk";

export interface WorkerLog {
  info: (event: string, fields?: Record<string, unknown>) => void;
  warn: (event: string, fields?: Record<string, unknown>) => void;
  error: (event: string, fields?: Record<string, unknown>) => void;
}

export interface WorkerDeps {
  service: JobService;
  /** The manifests the worker knows, with the jobs they declare. Called when the set of enabled modules changes. */
  loadManifests: () => Promise<ModuleManifest[]>;
  /** Enabled modules and their installed versions, read from the database on every tick. */
  enabledModules: () => Promise<Map<string, string>>;
  /** The handler of a declared job: the default export of its `entry` file. */
  loadHandler: (moduleId: string, entry: string) => Promise<JobHandler>;
  /** Old events are deleted on the same schedule as old jobs. Optional: a worker can run without the event log. */
  events?: { prune(): Promise<number> };
  workerId: string;
  log: WorkerLog;
  /** Jobs running at once. Default 4. */
  concurrency?: number;
  /** Time between ticks when nothing wakes the worker sooner. Default 1000 ms. */
  pollMs?: number;
  /** How long a stop waits for running jobs. Default 30 s. */
  graceMs?: number;
  /** How often the schedules are checked. Default 10 s. */
  scheduleEveryMs?: number;
  /** How often finished jobs are pruned. Default an hour. */
  pruneEveryMs?: number;
  now?: () => number;
}

const DEFAULTS = { concurrency: 4, pollMs: 1000, graceMs: 30_000, scheduleEveryMs: 10_000, pruneEveryMs: 3_600_000 };

class JobTimeoutError extends Error {
  constructor(seconds: number) {
    super(`the job did not finish within ${seconds} s`);
    this.name = "JobTimeoutError";
  }
}

/**
 * Runs the queue: every tick it gives back the jobs of dead workers, keeps the schedules alive, prunes, and claims as
 * many due jobs as there are free slots. A job runs its module's handler with a timeout; the outcome is written back
 * only if this worker still holds the job. Nothing a handler does can stop the loop.
 */
export class Worker {
  private readonly o: Required<Pick<WorkerDeps, "concurrency" | "pollMs" | "graceMs" | "scheduleEveryMs" | "pruneEveryMs">>;
  private readonly now: () => number;
  private readonly inFlight = new Set<Promise<void>>();
  private manifests = new Map<string, ModuleManifest>();
  private signature = "";
  private lastSchedule = Number.NEGATIVE_INFINITY;
  private lastPrune = Number.NEGATIVE_INFINITY;
  private wake: (() => void) | undefined;
  private stopping = false;

  constructor(private readonly deps: WorkerDeps) {
    this.o = {
      concurrency: deps.concurrency ?? DEFAULTS.concurrency,
      pollMs: deps.pollMs ?? DEFAULTS.pollMs,
      graceMs: deps.graceMs ?? DEFAULTS.graceMs,
      scheduleEveryMs: deps.scheduleEveryMs ?? DEFAULTS.scheduleEveryMs,
      pruneEveryMs: deps.pruneEveryMs ?? DEFAULTS.pruneEveryMs,
    };
    this.now = deps.now ?? (() => Date.now());
  }

  get running(): number {
    return this.inFlight.size;
  }

  /** One pass: recover, schedule, prune, claim, and start what was claimed (not waiting for it). Returns the jobs started. */
  async tick(): Promise<ClaimedJob[]> {
    const { service } = this.deps;
    const enabled = await this.deps.enabledModules();
    await this.refreshManifests(enabled);

    const recovered = await service.recoverExpired();
    if (recovered > 0) this.deps.log.warn("worker.jobs_recovered", { count: recovered });

    const at = this.now();
    if (at - this.lastSchedule >= this.o.scheduleEveryMs) {
      this.lastSchedule = at;
      await service.ensureSchedules(this.schedules(enabled));
    }
    if (at - this.lastPrune >= this.o.pruneEveryMs) {
      this.lastPrune = at;
      const pruned = await service.prune();
      if (pruned > 0) this.deps.log.info("worker.jobs_pruned", { count: pruned });
      const events = (await this.deps.events?.prune()) ?? 0;
      if (events > 0) this.deps.log.info("worker.events_pruned", { count: events });
    }

    // A stop was asked for while this tick was working: leave what is due for the next worker.
    if (this.stopping) return [];
    const free = this.o.concurrency - this.inFlight.size;
    const withJobs = [...enabled.keys()].filter((id) => (this.manifests.get(id)?.jobs ?? []).length > 0);
    const claimed = await service.claim(this.deps.workerId, free, withJobs);
    for (const job of claimed) {
      const running = this.execute(job).finally(() => {
        this.inFlight.delete(running);
        this.wake?.();
      });
      this.inFlight.add(running);
    }
    return claimed;
  }

  /** One tick, then wait for everything it started. For tests and one-shot use. */
  async runOnce(): Promise<ClaimedJob[]> {
    const claimed = await this.tick();
    await Promise.all([...this.inFlight]);
    return claimed;
  }

  /**
   * Ticks until `signal` aborts, then waits up to the grace period for running jobs. Never throws for a failed tick.
   * Returns how many jobs were still running when it gave up; they keep their lease and are recovered later.
   */
  async run(signal: AbortSignal): Promise<number> {
    this.deps.log.info("worker.started", { worker: this.deps.workerId, concurrency: this.o.concurrency });
    this.stopping = signal.aborted;
    const stop = () => {
      this.stopping = true;
      this.wake?.();
    };
    signal.addEventListener("abort", stop, { once: true });
    try {
      while (!signal.aborted) {
        let more = false;
        try {
          const claimed = await this.tick();
          // A full batch means there may be more waiting: go again as soon as a slot is free.
          more = claimed.length > 0 && this.inFlight.size < this.o.concurrency;
        } catch (error) {
          this.deps.log.error("worker.tick_failed", { error });
        }
        if (!more && !signal.aborted) await this.sleep(signal);
      }
    } finally {
      signal.removeEventListener("abort", stop);
    }
    const left = await this.drain();
    this.deps.log.info("worker.stopped", { worker: this.deps.workerId, abandoned: left });
    return left;
  }

  private sleep(signal: AbortSignal): Promise<void> {
    // An abort listener added to a signal that already aborted never fires: do not wait at all.
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        this.wake = undefined;
        resolve();
      };
      const timer = setTimeout(done, this.o.pollMs);
      signal.addEventListener("abort", done, { once: true });
      this.wake = done;
    });
  }

  /** Waits for running jobs up to the grace period. Returns how many were still running (they keep their lease). */
  private async drain(): Promise<number> {
    if (this.inFlight.size === 0) return 0;
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<"expired">((resolve) => {
      timer = setTimeout(() => resolve("expired"), this.o.graceMs);
    });
    await Promise.race([Promise.all([...this.inFlight]).then(() => "drained" as const), expired]);
    clearTimeout(timer);
    return this.inFlight.size;
  }

  /** Re-reads the manifests when the set of enabled modules or their versions changed. */
  private async refreshManifests(enabled: Map<string, string>): Promise<void> {
    const signature = [...enabled].map(([id, version]) => `${id}@${version}`).sort().join(",");
    if (signature === this.signature) return;
    const manifests = await this.deps.loadManifests();
    this.manifests = new Map(manifests.map((m) => [m.id, m]));
    this.signature = signature;
  }

  private schedules(enabled: Map<string, string>): ScheduledJob[] {
    const schedules: ScheduledJob[] = [];
    for (const id of enabled.keys()) {
      for (const job of this.manifests.get(id)?.jobs ?? []) {
        const everyMs = job.every === undefined ? null : parseInterval(job.every);
        if (everyMs === null) continue;
        schedules.push({ moduleId: id, name: job.name, everyMs, timeoutSeconds: job.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS, maxAttempts: job.maxAttempts ?? DEFAULT_MAX_ATTEMPTS });
      }
    }
    return schedules;
  }

  private async execute(job: ClaimedJob): Promise<void> {
    const { service, log, workerId } = this.deps;
    const fields = { moduleId: job.moduleId, job: job.name, jobId: job.id, attempt: job.attempt };
    log.info("worker.job_started", fields);
    try {
      await this.invoke(job);
    } catch (error) {
      const outcome = await service.fail(job, workerId, error).catch((writeError: unknown) => {
        log.error("worker.job_write_failed", { ...fields, error: writeError });
        return "lost" as const;
      });
      if (outcome === "dead") log.error("worker.job_dead", { ...fields, error });
      else if (outcome === "retry") log.warn("worker.job_failed", { ...fields, error });
      else log.warn("worker.job_lost", { ...fields, error });
      return;
    }
    const recorded = await service.complete(job, workerId).catch((writeError: unknown) => {
      log.error("worker.job_write_failed", { ...fields, error: writeError });
      return false;
    });
    if (recorded) log.info("worker.job_succeeded", fields);
    else log.warn("worker.job_lost", { ...fields, error: "the job was no longer this worker's when it finished" });
  }

  /** Runs the handler against its timeout. Rejects with the handler's error, or with a timeout error. */
  private async invoke(job: ClaimedJob): Promise<void> {
    const declared = this.manifests.get(job.moduleId)?.jobs?.find((candidate) => candidate.name === job.name);
    if (declared === undefined) throw new Error(`module "${job.moduleId}" no longer declares the job "${job.name}"`);
    const handler = await this.deps.loadHandler(job.moduleId, declared.entry);

    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new JobTimeoutError(job.timeoutSeconds);
        controller.abort(error);
        reject(error);
      }, job.timeoutSeconds * 1000);
    });
    const context: JobContext = { moduleId: job.moduleId, jobName: job.name, jobId: job.id, attempt: job.attempt, payload: job.payload, signal: controller.signal };
    const running = (async () => handler(context))();
    // If the timeout wins, the handler may still reject later; that is not an unhandled rejection.
    running.catch(() => undefined);
    try {
      await Promise.race([running, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
