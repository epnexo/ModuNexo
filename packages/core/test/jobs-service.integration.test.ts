import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import { JobError, JobService, SCHEDULE_KEY, retryDelayMs } from "../src/jobs/index.ts";
import { migrate } from "../src/runner.ts";
import { createPool } from "../src/pool.ts";
import { createScratchDatabase } from "../src/testing.ts";
import { Sandbox } from "./sandbox.ts";

let pool: pg.Pool | undefined;
let skipReason: string | undefined;
let dropScratch: (() => Promise<void>) | undefined;
let box: Sandbox;
let moduleId: string;
let otherId: string;
let offId: string;
let clock = new Date("2026-10-20T12:00:00Z");
let service: JobService;

const at = (seconds: number) => new Date(clock.getTime() + seconds * 1000);
const advance = (seconds: number) => {
  clock = at(seconds);
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
    { name: "fast", entry: "./jobs/fast.ts", timeoutSeconds: 5, maxAttempts: 2 },
    { name: "tick", entry: "./jobs/tick.ts", every: "1m", timeoutSeconds: 10, maxAttempts: 3 },
  ];
  moduleId = mod.manifest.id;
  otherId = box.add().manifest.id;
  const off = box.add();
  off.manifest.jobs = [{ name: "sync", entry: "./jobs/sync.ts" }];
  offId = off.manifest.id;
  const other = box.modules.find((m) => m.manifest.id === otherId)!;
  other.manifest.jobs = [{ name: "sync", entry: "./jobs/sync.ts" }];
  await migrate(pool, box.registry());
  service = new JobService(pool, box.registry(), { now: () => clock });
});

const ids = () => [moduleId, otherId, offId];
const wipe = async () => {
  await pool!.query("delete from core.jobs where module_id = any($1)", [ids()]);
  await pool!.query("delete from core.modules where id = any($1)", [ids()]);
  for (const [id, state] of [[moduleId, "enabled"], [otherId, "enabled"], [offId, "disabled"]]) {
    await pool!.query("insert into core.modules (id, state, installed_version) values ($1, $2, '1.0.0')", [id, state]);
  }
};

after(async () => {
  if (pool) {
    // Only this file's own modules: another file shares this database.
    await box.cleanup();
    await pool.end();
  }
  await dropScratch?.();
});

const test = (name: string, run: () => Promise<void>) =>
  it(name, async (t) => {
    if (!pool) return t.skip(skipReason);
    clock = new Date("2026-10-20T12:00:00Z");
    await wipe();
    await run();
  });

const row = async (id: number) => (await pool!.query("select * from core.jobs where id = $1", [id])).rows[0];
const enqueue = (payload: unknown = null, options = {}, name = "sync", id = moduleId) => service.enqueue(id, name, payload, options);

describe("retryDelayMs", () => {
  it("doubles from ten seconds and stops at an hour", () => {
    assert.deepEqual([1, 2, 3, 4].map(retryDelayMs), [10_000, 20_000, 40_000, 80_000]);
    assert.equal(retryDelayMs(9), 2_560_000);
    assert.equal(retryDelayMs(10), 3_600_000);
    assert.equal(retryDelayMs(20), 3_600_000);
    assert.equal(retryDelayMs(0), 10_000);
  });
});

describe("JobService.enqueue", () => {
  test("stores a queued job with the limits its declaration gives, or the defaults", async () => {
    const plain = await enqueue({ page: 2, deep: { a: [1, null, "x"] } });
    assert.equal(plain.deduplicated, false);
    const r = await row(plain.id);
    assert.deepEqual([r.status, r.attempts, r.max_attempts, r.timeout_seconds, r.enqueued_by, r.dedupe_key], ["queued", 0, 5, 60, "module", null]);
    assert.deepEqual(r.payload, { page: 2, deep: { a: [1, null, "x"] } });
    assert.deepEqual(r.run_at, clock);
    const fast = await enqueue(undefined, {}, "fast");
    const f = await row(fast.id);
    assert.deepEqual([f.max_attempts, f.timeout_seconds, f.payload], [2, 5, null]);
  });

  test("refuses an unknown module, an undeclared job and a module that is not enabled", async () => {
    await assert.rejects(service.enqueue("no-such-module", "sync", null), (e: unknown) => e instanceof JobError && /not registered/.test(e.message));
    await assert.rejects(enqueue(null, {}, "nope"), (e: unknown) => e instanceof JobError && /does not declare the job "nope" \(declared: fast, sync, tick\)/.test(e.message));
    await assert.rejects(service.enqueue(otherId, "nope", null), /declares the job|declare the job/);
    await assert.rejects(service.enqueue(offId, "sync", null), (e: unknown) => e instanceof JobError && /not enabled/.test(e.message));
    await pool!.query("delete from core.modules where id = $1", [moduleId]);
    await assert.rejects(enqueue(), /not enabled/);
    assert.equal((await pool!.query("select 1 from core.jobs where module_id = any($1)", [ids()])).rowCount, 0, "nothing was stored");
  });

  test("refuses a payload that is not JSON or is too large", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await assert.rejects(enqueue(circular), /must be JSON/);
    await assert.rejects(enqueue({ n: 10n }), /must be JSON/);
    await assert.rejects(enqueue("x".repeat(64 * 1024)), /over 64 KiB/);
    await enqueue("x".repeat(64 * 1024 - 2));
  });

  test("schedules a run later with runAt or delaySeconds, and refuses bad options", async () => {
    const later = await enqueue(null, { delaySeconds: 90 });
    assert.deepEqual((await row(later.id)).run_at, at(90));
    const dated = await enqueue(null, { runAt: at(3600) });
    assert.deepEqual((await row(dated.id)).run_at, at(3600));
    for (const options of [
      { runAt: at(1), delaySeconds: 1 },
      { runAt: new Date("nope") },
      { runAt: "2026-01-01" as never },
      { delaySeconds: -1 },
      { delaySeconds: Number.NaN },
      { delaySeconds: 31 * 86400 },
      { dedupeKey: "" },
      { dedupeKey: "~schedule" },
      { dedupeKey: " x" },
      { dedupeKey: "x".repeat(101) },
    ]) {
      await assert.rejects(enqueue(null, options), (e: unknown) => e instanceof JobError, JSON.stringify(options));
    }
  });

  test("returns the active job for the same dedupeKey, and adds again once it has finished", async () => {
    const first = await enqueue({ n: 1 }, { dedupeKey: "invoice-9" });
    const again = await enqueue({ n: 2 }, { dedupeKey: "invoice-9" });
    assert.deepEqual(again, { id: first.id, deduplicated: true });
    assert.deepEqual((await row(first.id)).payload, { n: 1 }, "the first payload stands");
    assert.notEqual((await enqueue({}, { dedupeKey: "invoice-10" })).id, first.id);
    assert.notEqual((await enqueue({}, { dedupeKey: "invoice-9" }, "fast")).id, first.id, "per job name");
    assert.notEqual((await service.enqueue(otherId, "sync", {}, { dedupeKey: "invoice-9" })).id, first.id, "per module");
    const [claimed] = await service.claim("w1", 1, [moduleId]);
    assert.equal(claimed!.id, first.id);
    assert.equal((await enqueue({}, { dedupeKey: "invoice-9" })).deduplicated, true, "a running job still holds the key");
    await service.complete(claimed!, "w1");
    const next = await enqueue({ n: 3 }, { dedupeKey: "invoice-9" });
    assert.equal(next.deduplicated, false);
    assert.notEqual(next.id, first.id);
  });

  test("refuses, as a JobError, a payload the database cannot store", async () => {
    await assert.rejects(enqueue({ text: "a\u0000b" }), (e: unknown) => e instanceof JobError && /cannot be stored/.test(e.message));
    assert.equal((await pool!.query("select 1 from core.jobs where module_id = any($1)", [ids()])).rowCount, 0);
  });

  test("two enqueues with one key at the same moment leave one job", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => enqueue({}, { dedupeKey: "same" })));
    assert.equal(new Set(results.map((r) => r.id)).size, 1);
    assert.equal(results.filter((r) => !r.deduplicated).length, 1);
  });
});

describe("JobService.claim", () => {
  test("takes due jobs of the given modules in order, counts the attempt and takes a lease", async () => {
    const late = await enqueue(null, { delaySeconds: 60 });
    const a = await enqueue({ n: "a" });
    advance(1);
    const b = await enqueue({ n: "b" });
    const other = await service.enqueue(otherId, "sync", null);
    advance(1);
    const claimed = await service.claim("w1", 10, [moduleId]);
    assert.deepEqual(claimed.map((j) => [j.id, j.payload, j.attempt, j.maxAttempts, j.timeoutSeconds]), [[a.id, { n: "a" }, 1, 5, 60], [b.id, { n: "b" }, 1, 5, 60]]);
    const r = await row(a.id);
    assert.deepEqual([r.status, r.locked_by, r.attempts], ["running", "w1", 1]);
    assert.deepEqual(r.started_at, clock);
    assert.deepEqual(r.lease_until, at(60 + 30), "timeout plus the 30 s grace");
    assert.equal((await row(late.id)).status, "queued", "not due yet");
    assert.equal((await row(other.id)).status, "queued", "another module's job was not asked for");
    assert.deepEqual(await service.claim("w2", 10, [moduleId]), [], "a running job is not claimed again");
    advance(60);
    assert.deepEqual((await service.claim("w2", 10, [moduleId])).map((j) => j.id), [late.id]);
  });

  test("respects the limit, takes nothing for no modules, and never claims a disabled module's job", async () => {
    for (let i = 0; i < 5; i++) await enqueue({ i });
    assert.equal((await service.claim("w1", 2, [moduleId])).length, 2);
    assert.deepEqual(await service.claim("w1", 0, [moduleId]), []);
    assert.deepEqual(await service.claim("w1", 5, []), []);
    await pool!.query("insert into core.jobs (module_id, name, max_attempts, timeout_seconds, enqueued_by) values ($1, 'sync', 3, 10, 'test')", [offId]);
    assert.deepEqual(await service.claim("w1", 50, [otherId]), []);
    assert.equal((await service.claim("w1", 50, [moduleId])).length, 3);
  });

  test("two workers claiming together never share a job", async () => {
    for (let i = 0; i < 20; i++) await enqueue({ i });
    const [one, two, three] = await Promise.all([service.claim("w1", 10, [moduleId]), service.claim("w2", 10, [moduleId]), service.claim("w3", 10, [moduleId])]);
    const all = [...one, ...two, ...three].map((j) => j.id);
    assert.equal(all.length, 20, "every job was claimed");
    assert.equal(new Set(all).size, 20, "and none twice");
    for (const [worker, jobs] of [["w1", one], ["w2", two], ["w3", three]] as const) {
      for (const job of jobs) assert.equal((await row(job.id)).locked_by, worker);
    }
  });
});

describe("JobService.complete and fail", () => {
  const claimOne = async (name = "sync", maxAttempts?: number) => {
    const { id } = await enqueue(null, {}, name);
    if (maxAttempts !== undefined) await pool!.query("update core.jobs set max_attempts = $2 where id = $1", [id, maxAttempts]);
    const [job] = await service.claim("w1", 1, [moduleId]);
    assert.equal(job!.id, id);
    return job!;
  };

  test("complete marks the job succeeded and clears the lease", async () => {
    const job = await claimOne();
    advance(5);
    assert.equal(await service.complete(job, "w1"), true);
    const r = await row(job.id);
    assert.deepEqual([r.status, r.lease_until, r.locked_by, r.last_error], ["succeeded", null, null, null]);
    assert.deepEqual(r.finished_at, clock);
  });

  test("complete from a worker that does not hold the job, or for another attempt, changes nothing", async () => {
    const job = await claimOne();
    assert.equal(await service.complete(job, "w2"), false);
    assert.equal(await service.complete({ ...job, attempt: 2 }, "w1"), false);
    assert.equal((await row(job.id)).status, "running");
    assert.equal(await service.complete(job, "w1"), true);
    assert.equal(await service.complete(job, "w1"), false, "a finished job is not finished twice");
  });

  test("fail queues a retry after the backoff, keeps the attempts and records the message", async () => {
    const job = await claimOne();
    assert.equal(await service.fail(job, "w1", new Error("upstream said 502")), "retry");
    const r = await row(job.id);
    assert.deepEqual([r.status, r.attempts, r.last_error, r.lease_until, r.locked_by, r.finished_at], ["queued", 1, "upstream said 502", null, null, null]);
    assert.deepEqual(r.run_at, at(10));
    assert.deepEqual(await service.claim("w1", 1, [moduleId]), [], "not before the delay");
    advance(10);
    const [second] = await service.claim("w1", 1, [moduleId]);
    assert.equal(second!.attempt, 2);
    assert.equal(await service.fail(second!, "w1", "plain text"), "retry");
    assert.deepEqual((await row(job.id)).run_at, at(20), "twice as long");
    assert.equal((await row(job.id)).last_error, "plain text");
  });

  test("fail makes the job dead when the attempts are spent, and stops retrying", async () => {
    const job = await claimOne("fast", 1);
    assert.equal(await service.fail(job, "w1", new Error("boom")), "dead");
    const r = await row(job.id);
    assert.deepEqual([r.status, r.last_error], ["dead", "boom"]);
    assert.deepEqual(r.finished_at, clock);
    advance(86400);
    assert.deepEqual(await service.claim("w1", 5, [moduleId]), []);
  });

  test("fail cuts a long message and copes with an error that has none", async () => {
    const job = await claimOne();
    await service.fail(job, "w1", new Error("x".repeat(5000)));
    const r = await row(job.id);
    assert.equal(r.last_error.length, 1000);
    assert.ok(r.last_error.endsWith("…"));
    advance(10);
    const [again] = await service.claim("w1", 1, [moduleId]);
    await service.fail(again!, "w1", new Error(""));
    assert.equal((await row(job.id)).last_error, "Error");
  });

  test("fail from a worker that lost the job answers lost and changes nothing", async () => {
    const job = await claimOne();
    assert.equal(await service.fail(job, "w2", new Error("x")), "lost");
    assert.equal(await service.fail({ ...job, attempt: 9 }, "w1", new Error("x")), "lost");
    assert.equal((await row(job.id)).status, "running");
  });
});

describe("JobService.recoverExpired", () => {
  test("gives back a job whose lease ran out, and leaves a live one alone", async () => {
    const dying = await enqueue(null, {}, "fast");
    const live = await enqueue(null, {}, "sync");
    const claimed = await service.claim("w1", 5, [moduleId]);
    assert.equal(claimed.length, 2);
    advance(5 + 30 - 1);
    assert.equal(await service.recoverExpired(), 0, "inside the lease");
    advance(1);
    assert.equal(await service.recoverExpired(), 0, "the lease ends at its last second");
    advance(1);
    assert.equal(await service.recoverExpired(), 1, "fast: 5 s timeout plus 30 s grace");
    const d = await row(dying.id);
    assert.deepEqual([d.status, d.attempts, d.lease_until, d.locked_by, d.finished_at], ["queued", 1, null, null, null]);
    assert.match(d.last_error, /lease expired/);
    assert.equal((await row(live.id)).status, "running");
  });

  test("makes the job dead when that was its last attempt", async () => {
    const { id } = await enqueue(null, {}, "fast");
    await pool!.query("update core.jobs set max_attempts = 1 where id = $1", [id]);
    await service.claim("w1", 1, [moduleId]);
    advance(36);
    assert.equal(await service.recoverExpired(), 1);
    const r = await row(id);
    assert.deepEqual([r.status, r.attempts], ["dead", 1]);
    assert.deepEqual(r.finished_at, clock);
  });

  test("a worker that lost the lease cannot overwrite the job the next worker holds", async () => {
    const { id } = await enqueue();
    const [first] = await service.claim("w1", 1, [moduleId]);
    advance(61 + 30);
    await service.recoverExpired();
    const [second] = await service.claim("w2", 1, [moduleId]);
    assert.equal(second!.id, id);
    assert.equal(second!.attempt, 2);
    assert.equal(await service.complete(first!, "w1"), false, "the slow worker's success is not recorded");
    assert.equal(await service.fail(first!, "w1", new Error("late")), "lost");
    assert.deepEqual([(await row(id)).status, (await row(id)).locked_by], ["running", "w2"]);
    assert.equal(await service.complete(second!, "w2"), true);
  });
});

describe("JobService.ensureSchedules", () => {
  const tick = () => [{ moduleId, name: "tick", everyMs: 60_000, timeoutSeconds: 10, maxAttempts: 3 }];
  const active = async () => (await pool!.query("select * from core.jobs where module_id = $1 and name = 'tick' and dedupe_key = $2 and status in ('queued','running')", [moduleId, SCHEDULE_KEY])).rows;

  test("queues the first run now, once, however often it is asked", async () => {
    assert.equal(await service.ensureSchedules(tick()), 1);
    assert.equal(await service.ensureSchedules(tick()), 0);
    const [r, ...rest] = await active();
    assert.equal(rest.length, 0);
    assert.deepEqual([r.enqueued_by, r.max_attempts, r.timeout_seconds, r.dedupe_key], ["schedule", 3, 10, "~schedule"]);
    assert.deepEqual(r.run_at, clock);
  });

  test("several workers asking together leave exactly one", async () => {
    const counts = await Promise.all(Array.from({ length: 6 }, () => service.ensureSchedules(tick())));
    assert.equal(counts.reduce((a, b) => a + b, 0), 1);
    assert.equal((await active()).length, 1);
  });

  test("queues the next run `every` after the previous one finished, not after it started", async () => {
    await service.ensureSchedules(tick());
    const [job] = await service.claim("w1", 1, [moduleId]);
    advance(25);
    await service.complete(job!, "w1");
    assert.equal(await service.ensureSchedules(tick()), 1);
    const [next] = await active();
    assert.deepEqual(next.run_at, at(60));
  });

  test("keeps scheduling after a run went dead, and runs at once when the worker was down past the due time", async () => {
    await service.ensureSchedules(tick());
    await pool!.query("update core.jobs set max_attempts = 1 where module_id = $1 and name = 'tick'", [moduleId]);
    const [job] = await service.claim("w1", 1, [moduleId]);
    await service.fail({ ...job!, maxAttempts: 1 }, "w1", new Error("always"));
    advance(3600);
    await service.ensureSchedules(tick());
    const [next] = await active();
    assert.ok(next.run_at.getTime() < clock.getTime(), "due since a while ago, so it runs on the next claim");
    assert.equal((await service.claim("w1", 1, [moduleId])).length, 1);
  });

  test("adds nothing while a run is queued or running", async () => {
    await service.ensureSchedules(tick());
    await service.claim("w1", 1, [moduleId]);
    assert.equal(await service.ensureSchedules(tick()), 0);
  });

  test("a module's own dedupe key never collides with the schedule's", async () => {
    await service.ensureSchedules(tick());
    const own = await enqueue(null, { dedupeKey: "tick-now" }, "tick");
    assert.equal(own.deduplicated, false);
    assert.equal((await active()).length, 1, "the schedule still holds its one run");
    assert.equal((await pool!.query("select 1 from core.jobs where module_id = $1 and name = 'tick' and status = 'queued'", [moduleId])).rowCount, 2);
  });
});

describe("JobService.list, cancel, retry and prune", () => {
  test("lists newest first, filters, and gives a payload only when asked", async () => {
    const a = await enqueue({ secret: "s" });
    const b = await service.enqueue(otherId, "sync", { n: 2 });
    await service.claim("w1", 1, [moduleId]);
    const all = (await service.list()).filter((j) => ids().includes(j.moduleId));
    assert.deepEqual(all.map((j) => j.id), [b.id, a.id]);
    assert.deepEqual((await service.list({ moduleId })).map((j) => j.id), [a.id]);
    assert.deepEqual((await service.list({ moduleId, status: "running" })).map((j) => j.id), [a.id]);
    assert.deepEqual(await service.list({ moduleId, status: "dead" }), []);
    assert.ok(!("payload" in all[0]!));
    assert.deepEqual((await service.list({ moduleId, payload: true }))[0]!.payload, { secret: "s" });
    assert.equal((await service.list({ limit: 1 })).length, 1);
  });

  test("cancels a queued job and refuses any other", async () => {
    const queued = await enqueue();
    const cancelled = await service.cancel(queued.id);
    assert.equal(cancelled.status, "cancelled");
    assert.deepEqual(cancelled.finishedAt, clock);
    await assert.rejects(service.cancel(queued.id), /is cancelled: only a queued job/);
    await enqueue();
    const [running] = await service.claim("w1", 1, [moduleId]);
    await assert.rejects(service.cancel(running!.id), /is running: only a queued job/);
    await assert.rejects(service.cancel(999_999_999), /there is no job 999999999/);
    assert.equal((await service.claim("w1", 5, [moduleId])).length, 0, "a cancelled job never runs");
  });

  test("retries a dead job from scratch and refuses any other", async () => {
    const { id } = await enqueue(null, {}, "fast");
    await assert.rejects(service.retry(id), /is queued: only a dead job/);
    await pool!.query("update core.jobs set max_attempts = 1 where id = $1", [id]);
    const [job] = await service.claim("w1", 1, [moduleId]);
    await service.fail(job!, "w1", new Error("boom"));
    assert.equal((await row(id)).status, "dead");
    advance(60);
    const retried = await service.retry(id);
    assert.deepEqual([retried.status, retried.attempts, retried.finishedAt, retried.lastError], ["queued", 0, null, "boom"]);
    assert.deepEqual(retried.runAt, clock);
    assert.equal((await service.claim("w1", 1, [moduleId]))[0]!.id, id);
    await assert.rejects(service.retry(999_999_999), /there is no job/);
  });

  test("refuses, as a JobError, to retry a dead job while another job holds its dedupe key", async () => {
    const first = await enqueue({ n: 1 }, { dedupeKey: "dup" }, "fast");
    await pool!.query("update core.jobs set max_attempts = 1 where id = $1", [first.id]);
    const [job] = await service.claim("w1", 1, [moduleId]);
    await service.fail(job!, "w1", new Error("boom"));
    assert.equal((await row(first.id)).status, "dead");
    const second = await enqueue({ n: 2 }, { dedupeKey: "dup" }, "fast");
    assert.equal(second.deduplicated, false, "a dead job no longer holds the key");
    await assert.rejects(service.retry(first.id), (e: unknown) => e instanceof JobError && /dedupe key/.test(e.message) && new RegExp(`${second.id}`).test(e.message));
    assert.equal((await row(first.id)).status, "dead", "and the dead job is left as it was");
  });

  test("prunes finished jobs older than 14 days and nothing else", async () => {
    const old = await enqueue();
    const recent = await enqueue();
    const queued = await enqueue();
    const stuck = await enqueue();
    const claimed = await service.claim("w1", 2, [moduleId]);
    await service.complete(claimed[0]!, "w1");
    await service.complete(claimed[1]!, "w1");
    await pool!.query("update core.jobs set finished_at = $2 where id = $1", [old.id, at(-14 * 86400 - 1)]);
    await pool!.query("update core.jobs set finished_at = $2 where id = $1", [recent.id, at(-14 * 86400 + 60)]);
    assert.equal(await service.prune(), 1);
    assert.equal(await row(old.id), undefined);
    assert.ok(await row(recent.id));
    assert.ok(await row(queued.id));
    assert.ok(await row(stuck.id));
  });
});
