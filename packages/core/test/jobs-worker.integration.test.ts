import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import { EVENTS_PUBLISHER, type EventsPublisher, type JobContext, type JobHandler, JOBS_ENQUEUER, type JobsEnqueuer, enqueueJob, publishEvent } from "@modunexo/sdk";
import { EventService } from "../src/events/index.ts";
import { JobService, Worker, type WorkerDeps, registerModuleRuntime } from "../src/jobs/index.ts";
import { migrate } from "../src/runner.ts";
import { createPool } from "../src/pool.ts";
import { createScratchDatabase } from "../src/testing.ts";
import { Sandbox } from "./sandbox.ts";

let pool: pg.Pool | undefined;
let skipReason: string | undefined;
let dropScratch: (() => Promise<void>) | undefined;
let box: Sandbox;
let moduleId: string;
let offId: string;
let clock = new Date("2026-10-20T12:00:00Z");
let service: JobService;

const advance = (seconds: number) => {
  clock = new Date(clock.getTime() + seconds * 1000);
};

before(async () => {
  // A database of its own: recovering expired leases looks at the whole table, and the tests set the clock by hand,
  // so another file sharing this table would see its running jobs given back.
  const scratch = await createScratchDatabase();
  if (!scratch.url) {
    skipReason = scratch.skipReason;
    return;
  }
  dropScratch = scratch.drop;
  pool = createPool(scratch.url);
  box = new Sandbox(pool);
  const mod = box.add();
  mod.manifest.jobs = [
    { name: "sync", entry: "./jobs/sync.ts" },
    { name: "flaky", entry: "./jobs/flaky.ts", maxAttempts: 3 },
    { name: "slow", entry: "./jobs/slow.ts", timeoutSeconds: 1, maxAttempts: 1 },
  ];
  moduleId = mod.manifest.id;
  const off = box.add();
  off.manifest.jobs = [{ name: "sync", entry: "./jobs/sync.ts" }];
  offId = off.manifest.id;
  await migrate(pool, box.registry());
  service = new JobService(pool, box.registry(), { now: () => clock });
});

const ids = () => [moduleId, offId];
after(async () => {
  if (pool) {
    await box.cleanup();
    await pool.end();
  }
  await dropScratch?.();
});

const test = (name: string, run: () => Promise<void>) =>
  it(name, async (t) => {
    if (!pool) return t.skip(skipReason);
    clock = new Date("2026-10-20T12:00:00Z");
    await pool.query("delete from core.jobs where module_id = any($1)", [ids()]);
    await pool.query("delete from core.modules where id = any($1)", [ids()]);
    await pool.query("insert into core.modules (id, state, installed_version) values ($1, 'enabled', '1.0.0'), ($2, 'disabled', '1.0.0')", [moduleId, offId]);
    await run();
  });

/** Declares the repeating job only for the test that needs it: a repeating job queues itself on every tick. */
const withTick = async (run: () => Promise<void>) => {
  const manifest = box.modules.find((m) => m.manifest.id === moduleId)!.manifest;
  const declared = manifest.jobs!;
  manifest.jobs = [...declared, { name: "tick", entry: "./jobs/tick.ts", every: "1m" }];
  try {
    await run();
  } finally {
    manifest.jobs = declared;
  }
};

const row = async (id: number) => (await pool!.query("select * from core.jobs where id = $1", [id])).rows[0];
const enqueue = (name: string, payload: unknown = null, options = {}) => service.enqueue(moduleId, name, payload, options);

interface Logged {
  event: string;
  fields: Record<string, unknown> | undefined;
}

function makeWorker(handlers: Record<string, JobHandler>, extra: Partial<WorkerDeps> = {}) {
  const logged: Logged[] = [];
  const record = (event: string, fields?: Record<string, unknown>) => logged.push({ event, fields });
  const loads: string[] = [];
  const worker = new Worker({
    service,
    loadManifests: async () => box.modules.map((m) => m.manifest),
    enabledModules: async () => new Map((await pool!.query("select id, installed_version from core.modules where state = 'enabled' and id = any($1)", [ids()])).rows.map((r) => [r.id as string, r.installed_version as string])),
    loadHandler: async (_module, entry) => {
      loads.push(entry);
      const handler = handlers[entry.replace(/^\.\/jobs\//, "").replace(/\.ts$/, "")];
      if (handler === undefined) throw new Error(`cannot load ${entry}`);
      return handler;
    },
    workerId: "w1",
    log: { info: record, warn: record, error: record },
    now: () => clock.getTime(),
    scheduleEveryMs: 0,
    pruneEveryMs: 0,
    pollMs: 20,
    ...extra,
  });
  return { worker, logged, loads };
}

describe("Worker: running a job", () => {
  test("runs the handler with its context and records success", async () => {
    const seen: JobContext[] = [];
    const { worker, logged } = makeWorker({ sync: async (ctx) => void seen.push(ctx) });
    const { id } = await enqueue("sync", { page: 3 });
    const claimed = await worker.runOnce();
    assert.deepEqual(claimed.map((j) => j.id), [id]);
    assert.equal(seen.length, 1);
    assert.deepEqual([seen[0]!.moduleId, seen[0]!.jobName, seen[0]!.jobId, seen[0]!.attempt, seen[0]!.payload], [moduleId, "sync", id, 1, { page: 3 }]);
    assert.equal(seen[0]!.signal.aborted, false);
    const r = await row(id);
    assert.deepEqual([r.status, r.locked_by, r.lease_until], ["succeeded", null, null]);
    assert.deepEqual(logged.map((l) => l.event), ["worker.job_started", "worker.job_succeeded"]);
  });

  test("accepts a handler that returns without a promise", async () => {
    const { worker } = makeWorker({ sync: () => undefined });
    const { id } = await enqueue("sync");
    await worker.runOnce();
    assert.equal((await row(id)).status, "succeeded");
  });

  test("retries a failing job after the backoff and ends it dead when the attempts are spent", async () => {
    const attempts: number[] = [];
    const { worker, logged } = makeWorker({
      flaky: async (ctx) => {
        attempts.push(ctx.attempt);
        throw new Error(`attempt ${ctx.attempt} failed`);
      },
    });
    const { id } = await enqueue("flaky");
    await worker.runOnce();
    let r = await row(id);
    assert.deepEqual([r.status, r.attempts, r.last_error], ["queued", 1, "attempt 1 failed"]);
    assert.deepEqual((await worker.runOnce()).length, 0, "not before the delay");
    advance(10);
    await worker.runOnce();
    r = await row(id);
    assert.deepEqual([r.status, r.attempts], ["queued", 2]);
    advance(19);
    assert.deepEqual((await worker.runOnce()).length, 0, "the second delay is twice as long");
    advance(1);
    await worker.runOnce();
    r = await row(id);
    assert.deepEqual([r.status, r.attempts, r.last_error], ["dead", 3, "attempt 3 failed"]);
    assert.deepEqual(attempts, [1, 2, 3]);
    advance(86_400);
    assert.deepEqual(await worker.runOnce(), [], "a dead job is left alone");
    assert.deepEqual(logged.filter((l) => l.event.startsWith("worker.job_") && l.event !== "worker.job_started").map((l) => l.event), ["worker.job_failed", "worker.job_failed", "worker.job_dead"]);
  });

  test("a handler that succeeds on a retry ends succeeded with the error cleared", async () => {
    const { worker } = makeWorker({ flaky: async (ctx) => { if (ctx.attempt < 2) throw new Error("not yet"); } });
    const { id } = await enqueue("flaky");
    await worker.runOnce();
    advance(10);
    await worker.runOnce();
    const r = await row(id);
    assert.deepEqual([r.status, r.attempts, r.last_error], ["succeeded", 2, null]);
  });

  test("marks a handler that outlives its timeout failed and aborts its signal, even if it ignores the signal", async () => {
    let aborted = false;
    const { worker } = makeWorker({
      slow: (ctx) => {
        ctx.signal.addEventListener("abort", () => (aborted = true));
        return new Promise<void>(() => {});
      },
    });
    const { id } = await enqueue("slow");
    const started = Date.now();
    await worker.runOnce();
    const took = Date.now() - started;
    assert.ok(took >= 900 && took < 3000, `took ${took} ms`);
    assert.equal(aborted, true);
    const r = await row(id);
    assert.deepEqual([r.status, r.last_error], ["dead", "the job did not finish within 1 s"]);
  });

  test("a handler that rejects after its timeout does not crash the worker", async () => {
    const { worker } = makeWorker({ slow: () => new Promise<void>((_, reject) => setTimeout(() => reject(new Error("late")), 1300)) });
    await enqueue("slow");
    await worker.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 500));
  });

  test("fails a job whose handler cannot be loaded or whose declaration is gone, and keeps going", async () => {
    const { worker, logged } = makeWorker({ sync: async () => {} });
    const missing = await enqueue("flaky");
    const fine = await enqueue("sync");
    await worker.runOnce();
    assert.equal((await row(fine.id)).status, "succeeded");
    assert.match((await row(missing.id)).last_error, /cannot load \.\/jobs\/flaky\.ts/);
    assert.ok(logged.some((l) => l.event === "worker.job_failed"));
    const orphan = await pool!.query("insert into core.jobs (module_id, name, run_at, max_attempts, timeout_seconds, enqueued_by) values ($1, 'removed', $2, 1, 10, 'test') returning id", [moduleId, clock]);
    await worker.runOnce();
    const r = await row(orphan.rows[0].id);
    assert.deepEqual([r.status, r.last_error], ["dead", `module "${moduleId}" no longer declares the job "removed"`]);
  });

  test("leaves the jobs of a disabled module queued and runs them once it is enabled", async () => {
    const ran: string[] = [];
    const { worker } = makeWorker({ sync: async (ctx) => void ran.push(ctx.moduleId) });
    const off = await service.enqueue(offId, "sync", null).catch(() => undefined);
    assert.equal(off, undefined, "enqueue refuses a disabled module");
    const inserted = await pool!.query("insert into core.jobs (module_id, name, run_at, max_attempts, timeout_seconds, enqueued_by) values ($1, 'sync', $2, 3, 10, 'test') returning id", [offId, clock]);
    await worker.runOnce();
    assert.equal((await row(inserted.rows[0].id)).status, "queued");
    assert.deepEqual(ran, []);
    await pool!.query("update core.modules set state = 'enabled' where id = $1", [offId]);
    await worker.runOnce();
    assert.equal((await row(inserted.rows[0].id)).status, "succeeded");
    assert.deepEqual(ran, [offId]);
  });
});

describe("Worker: concurrency and sharing", () => {
  test("never runs more jobs at once than its concurrency, and picks up the rest as slots free", async () => {
    let running = 0;
    let peak = 0;
    let finished = 0;
    const gates: Array<() => void> = [];
    const { worker } = makeWorker(
      {
        sync: async () => {
          running++;
          peak = Math.max(peak, running);
          await new Promise<void>((resolve) => gates.push(resolve));
          running--;
          finished++;
        },
      },
      { concurrency: 2 },
    );
    for (let i = 0; i < 5; i++) await enqueue("sync", { i });
    const first = await worker.tick();
    assert.equal(first.length, 2);
    assert.equal(worker.running, 2);
    assert.equal((await worker.tick()).length, 0, "no free slot");
    for (let guard = 0; guard < 50 && finished < 5; guard++) {
      while (gates.length > 0) gates.shift()!();
      await new Promise((resolve) => setTimeout(resolve, 5));
      await worker.tick();
    }
    // A handler is done before its outcome is written: wait for the worker to record the last one.
    for (let guard = 0; guard < 100 && worker.running > 0; guard++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(finished, 5);
    assert.equal(peak, 2);
    assert.equal((await pool!.query("select count(*)::int as n from core.jobs where module_id = $1 and status = 'succeeded'", [moduleId])).rows[0].n, 5);
  });

  test("two workers on one queue run every job exactly once", async () => {
    const counts = new Map<number, number>();
    const handlers = { sync: async (ctx: JobContext) => void counts.set(ctx.jobId, (counts.get(ctx.jobId) ?? 0) + 1) };
    const a = makeWorker(handlers, { workerId: "wa", concurrency: 3 }).worker;
    const b = makeWorker(handlers, { workerId: "wb", concurrency: 3 }).worker;
    const made = [];
    for (let i = 0; i < 12; i++) made.push((await enqueue("sync", { i })).id);
    for (let round = 0; round < 6; round++) await Promise.all([a.runOnce(), b.runOnce()]);
    assert.deepEqual([...counts.keys()].sort((x, y) => x - y), made);
    assert.ok([...counts.values()].every((n) => n === 1), JSON.stringify([...counts]));
  });
});

describe("Worker: dead workers, schedules and tick failures", () => {
  test("recovers a job whose worker died and runs it as its next attempt", async () => {
    const attempts: number[] = [];
    const { worker, logged } = makeWorker({ sync: async (ctx) => void attempts.push(ctx.attempt) });
    const { id } = await enqueue("sync");
    const [taken] = await service.claim("dead-worker", 1, [moduleId]);
    assert.equal(taken!.id, id);
    assert.deepEqual(await worker.runOnce(), [], "its lease is still good");
    advance(60 + 30 + 1);
    await worker.runOnce();
    assert.deepEqual(attempts, [2]);
    assert.equal((await row(id)).status, "succeeded");
    assert.ok(logged.some((l) => l.event === "worker.jobs_recovered" && l.fields?.count === 1));
    assert.equal(await service.complete(taken!, "dead-worker"), false, "the dead worker cannot claim the result");
  });

  test("keeps a scheduled job going: first run at once, the next an interval after it finished", () =>
    withTick(async () => {
      const ran: number[] = [];
      const { worker } = makeWorker({ tick: async () => void ran.push(clock.getTime()) });
      await worker.runOnce();
      assert.equal(ran.length, 1);
      advance(59);
      await worker.runOnce();
      assert.equal(ran.length, 1, "not yet");
      advance(1);
      await worker.runOnce();
      assert.equal(ran.length, 2);
      advance(120);
      await worker.runOnce();
      assert.equal(ran.length, 3, "after a pause it runs once, not once per missed interval");
      await worker.tick();
      const scheduled = (await pool!.query("select count(*)::int as n from core.jobs where module_id = $1 and name = 'tick' and status in ('queued','running')", [moduleId])).rows[0].n;
      assert.equal(scheduled, 1);
    }));

  test("schedules nothing for a disabled module", () =>
    withTick(async () => {
      const { worker } = makeWorker({ tick: async () => {} });
      await pool!.query("update core.modules set state = 'disabled' where id = $1", [moduleId]);
      await worker.runOnce();
      assert.equal((await pool!.query("select 1 from core.jobs where module_id = $1", [moduleId])).rowCount, 0);
    }));

  test("reloads the manifests when the enabled set changes, and not on every tick", async () => {
    let loads = 0;
    const { worker } = makeWorker({ sync: async () => {} }, {
      loadManifests: async () => {
        loads++;
        return box.modules.map((m) => m.manifest);
      },
    });
    await worker.runOnce();
    await worker.runOnce();
    assert.equal(loads, 1);
    await pool!.query("update core.modules set installed_version = '1.1.0' where id = $1", [moduleId]);
    await worker.runOnce();
    assert.equal(loads, 2);
  });

  test("prunes old finished jobs on its schedule", async () => {
    const { worker } = makeWorker({ sync: async () => {} });
    const { id } = await enqueue("sync");
    await worker.runOnce();
    advance(15 * 86_400);
    await worker.runOnce();
    assert.equal(await row(id), undefined);
  });

  test("prunes old events on its schedule and keeps recent ones", async () => {
    const { worker } = makeWorker({ sync: async () => {} }, { events: new EventService(pool!, box.registry(), { now: () => clock }) });
    const insert = (age: number) => pool!.query("insert into core.events (module_id, type, created_at) values ($1, $2, $3) returning id", [moduleId, `${moduleId}.x`, new Date(clock.getTime() - age * 86_400_000)]);
    const old = (await insert(8)).rows[0].id;
    const recent = (await insert(6)).rows[0].id;
    await worker.runOnce();
    const left = (await pool!.query("select id from core.events where id = any($1)", [[old, recent]])).rows.map((r) => r.id);
    assert.deepEqual(left, [recent]);
    await pool!.query("delete from core.events where id = $1", [recent]);
  });
});

describe("Worker.run", () => {
  test("keeps ticking until it is aborted, survives a failing tick, and stops cleanly", async () => {
    let failures = 0;
    const flaky = new Proxy(service, {
      get(target, prop, receiver) {
        if (prop === "recoverExpired") {
          return async () => {
            if (failures++ === 0) throw new Error("connection reset");
            return target.recoverExpired();
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const ran: number[] = [];
    const { worker, logged } = makeWorker({ sync: async (ctx) => void ran.push(ctx.jobId) }, { service: flaky });
    const { id } = await enqueue("sync");
    const controller = new AbortController();
    const done = worker.run(controller.signal);
    for (let i = 0; i < 100 && ran.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await done;
    assert.deepEqual(ran, [id]);
    assert.ok(logged.some((l) => l.event === "worker.tick_failed"));
    assert.deepEqual([logged[0]!.event, logged.at(-1)!.event], ["worker.started", "worker.stopped"]);
  });

  test("on stop waits for a running job to finish before it returns", async () => {
    let release!: () => void;
    let started!: () => void;
    const begun = new Promise<void>((resolve) => (started = resolve));
    const { worker } = makeWorker({ sync: () => new Promise<void>((resolve) => { release = resolve; started(); }) });
    const { id } = await enqueue("sync");
    const controller = new AbortController();
    const done = worker.run(controller.signal);
    await begun;
    controller.abort();
    let returned = false;
    void done.then(() => (returned = true));
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(returned, false, "still waiting for the job");
    release();
    await done;
    assert.equal((await row(id)).status, "succeeded");
  });

  test("on stop gives up after the grace period and leaves the job running for its lease to expire", async () => {
    const { worker, logged } = makeWorker({ sync: () => new Promise<void>(() => {}) }, { graceMs: 100 });
    const { id } = await enqueue("sync");
    const controller = new AbortController();
    const done = worker.run(controller.signal);
    for (let i = 0; i < 100 && worker.running === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    const started = Date.now();
    await done;
    assert.ok(Date.now() - started < 1500);
    assert.equal((await row(id)).status, "running", "recovered later by a lease that expires");
    assert.equal(logged.at(-1)!.fields?.abandoned, 1);
  });

  test("a second tick while a slot frees up starts the next job without waiting for the poll", async () => {
    const order: number[] = [];
    const { worker } = makeWorker({ sync: async (ctx) => { order.push(ctx.jobId); await new Promise((resolve) => setTimeout(resolve, 30)); } }, { concurrency: 1, pollMs: 5000 });
    for (let i = 0; i < 3; i++) await enqueue("sync", { i });
    const controller = new AbortController();
    const done = worker.run(controller.signal);
    const started = Date.now();
    for (let i = 0; i < 200 && order.length < 3; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await done;
    assert.equal(order.length, 3);
    assert.ok(Date.now() - started < 2000, "a finished job wakes the loop; the 5 s poll was not needed");
  });
});

describe("Worker.run: stopping", () => {
  /** A service whose first recovery pass takes a while, so a stop request can land in the middle of a tick. */
  const slowFirstTick = (delayMs: number) => {
    let first = true;
    return new Proxy(service, {
      get(target, prop, receiver) {
        if (prop === "recoverExpired") {
          return async () => {
            if (first) {
              first = false;
              await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
            return target.recoverExpired();
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };

  test("a stop that arrives during a tick ends the run at once, not after the poll interval", async () => {
    const { worker } = makeWorker({ sync: async () => {} }, { service: slowFirstTick(150), pollMs: 5000 });
    const controller = new AbortController();
    const started = Date.now();
    const done = worker.run(controller.signal);
    setTimeout(() => controller.abort(), 30);
    await done;
    assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms`);
  });

  test("a stop that arrives during a tick does not start new jobs", async () => {
    const { worker } = makeWorker({ sync: async () => {} }, { service: slowFirstTick(150), pollMs: 5000 });
    const { id } = await enqueue("sync");
    const controller = new AbortController();
    const done = worker.run(controller.signal);
    setTimeout(() => controller.abort(), 30);
    await done;
    assert.equal((await row(id)).status, "queued", "left for the next worker");
  });

  test("answers how many jobs it abandoned", async () => {
    const { worker } = makeWorker({ sync: () => new Promise<void>(() => {}) }, { graceMs: 50 });
    await enqueue("sync");
    const controller = new AbortController();
    const done = worker.run(controller.signal);
    for (let i = 0; i < 100 && worker.running === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    assert.equal(await done, 1);
    const idle = makeWorker({ sync: async () => {} }).worker;
    const quiet = new AbortController();
    quiet.abort();
    assert.equal(await idle.run(quiet.signal), 0);
  });
});

describe("registerModuleRuntime", () => {
  test("lets a handler enqueue another job through the SDK", async () => {
    registerModuleRuntime(pool!, { current: box.registry() });
    try {
      const { worker } = makeWorker({ sync: async (ctx) => void (await enqueueJob(ctx.moduleId, "flaky", { from: ctx.jobId }, { dedupeKey: "chained" })) });
      const { id } = await enqueue("sync");
      await worker.runOnce();
      const chained = (await pool!.query("select payload, dedupe_key, enqueued_by from core.jobs where module_id = $1 and name = 'flaky'", [moduleId])).rows;
      assert.deepEqual(chained, [{ payload: { from: id }, dedupe_key: "chained", enqueued_by: "module" }]);
    } finally {
      delete (globalThis as typeof globalThis & { [JOBS_ENQUEUER]?: JobsEnqueuer })[JOBS_ENQUEUER];
    }
  });

  test("lets a handler publish an event through the SDK", async () => {
    const manifest = box.modules.find((m) => m.manifest.id === moduleId)!.manifest;
    manifest.events = [{ name: "synced" }];
    registerModuleRuntime(pool!, { current: box.registry() });
    try {
      const { worker } = makeWorker({ sync: async (ctx) => void (await publishEvent(ctx.moduleId, "synced", { from: ctx.jobId })) });
      const { id } = await enqueue("sync");
      await worker.runOnce();
      const events = (await pool!.query("select module_id, type, payload from core.events where module_id = $1", [moduleId])).rows;
      assert.deepEqual(events, [{ module_id: moduleId, type: `${moduleId}.synced`, payload: { from: id } }]);
    } finally {
      delete manifest.events;
      delete (globalThis as typeof globalThis & { [EVENTS_PUBLISHER]?: EventsPublisher })[EVENTS_PUBLISHER];
      await pool!.query("delete from core.events where module_id = $1", [moduleId]);
    }
  });
});
