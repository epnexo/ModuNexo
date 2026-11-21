import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import { checkDeclarations } from "../src/data/module-declarations.ts";
import { ModuleRoles } from "../src/data/module-roles.ts";
import { EventError, EventService } from "../src/events/index.ts";
import { DiskStorage, FileError, FileService } from "../src/files/index.ts";
import { JobError, JobService } from "../src/jobs/index.ts";
import { createPool } from "../src/pool.ts";
import { migrate } from "../src/runner.ts";
import { createScratchDatabase } from "../src/testing.ts";
import { Sandbox } from "./sandbox.ts";

let pool: pg.Pool | undefined;
let roles: ModuleRoles;
let box: Sandbox;
let skipReason: string | undefined;
let dropScratch: (() => Promise<void>) | undefined;
let dir: string;
let pub = "";
let sub = "";
let other = "";
const schemas: string[] = [];

before(async () => {
  const scratch = await createScratchDatabase();
  if (!scratch.url) {
    skipReason = scratch.skipReason;
    return;
  }
  dropScratch = scratch.drop;
  pool = createPool(scratch.url);
  roles = new ModuleRoles({ pool, connectionString: scratch.url, masterKey: "k".repeat(40) });
  dir = await mkdtemp(join(tmpdir(), "modunexo-definers-"));
  box = new Sandbox(pool);
  const p = box.add();
  p.manifest.events = [{ name: "created" }];
  p.manifest.jobs = [{ name: "own", entry: "./jobs/own.ts", maxAttempts: 3, timeoutSeconds: 20 }];
  p.manifest.files = { maxBytes: 1024 };
  pub = p.manifest.id;
  const s = box.add({ [pub]: "^1.0.0" });
  s.manifest.jobs = [{ name: "on_created", entry: "./jobs/on.ts", maxAttempts: 2, timeoutSeconds: 15 }];
  s.manifest.subscriptions = [{ event: `${pub}.created`, job: "on_created" }];
  sub = s.manifest.id;
  const o = box.add();
  o.manifest.jobs = [{ name: "own", entry: "./jobs/own.ts" }];
  other = o.manifest.id;
  for (const m of box.modules) schemas.push(m.manifest.schema);
  await migrate(pool, box.registry(), { moduleRoles: roles });
});

after(async () => {
  if (pool) {
    for (const schema of schemas) {
      await pool.query(`drop schema if exists "${schema}" cascade`).catch(() => undefined);
      await roles.drop(schema).catch(() => undefined);
    }
    await roles.close();
    await box.cleanup();
    await pool.end();
  }
  if (dir) await rm(dir, { recursive: true, force: true });
  await dropScratch?.();
});

const test = (name: string, run: () => Promise<void>) =>
  it(name, async (t) => {
    if (!pool) return t.skip(skipReason);
    await pool.query("delete from core.jobs");
    await pool.query("delete from core.events");
    await pool.query("delete from core.files");
    await pool.query("delete from core.modules where id = any($1)", [[pub, sub, other]]);
    await pool.query("insert into core.modules (id, state, installed_version) values ($1, 'enabled', '1.0.0'), ($2, 'enabled', '1.0.0'), ($3, 'enabled', '1.0.0')", [pub, sub, other]);
    await run();
  });

/** Runs `work` in a transaction on the module's own login, the way `getDb(...).transaction` will. */
async function asModule<T>(moduleId: string, work: (tx: pg.PoolClient) => Promise<T>, commit = true): Promise<T> {
  const schema = box.modules.find((m) => m.manifest.id === moduleId)!.manifest.schema;
  const client = await (await roles.pool(schema)).connect();
  try {
    await client.query("begin");
    const value = await work(client);
    await client.query(commit ? "commit" : "rollback");
    return value;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const events = () => new EventService(pool!, box.registry());
const jobs = () => new JobService(pool!, box.registry());
const files = () => new FileService(pool!, box.registry(), new DiskStorage(join(dir, "files")));

describe("declarations kept for the database", () => {
  test("the tables hold the jobs and subscriptions of the manifests, and the check finds no difference", async () => {
    const declared = await pool!.query("select name, max_attempts, timeout_seconds from core.module_jobs where module_id = $1", [pub]);
    assert.deepEqual(declared.rows, [{ name: "own", max_attempts: 3, timeout_seconds: 20 }]);
    const subs = await pool!.query("select event_type, job_name from core.event_subscriptions where subscriber_module = $1", [sub]);
    assert.deepEqual(subs.rows, [{ event_type: `${pub}.created`, job_name: "on_created" }]);
    assert.deepEqual(await checkDeclarations(pool!, box.registry()), []);
  });

  test("the database refuses an event the module did not declare, even when its login calls the function directly", async () => {
    const declared = await pool!.query("select name from core.module_declared_events where module_id = $1", [pub]);
    assert.deepEqual(declared.rows, [{ name: "created" }]);
    await assert.rejects(asModule(pub, (tx) => tx.query("select core.publish_event('undeclared', '{}'::jsonb)")), /does not declare the event "undeclared"/);
    assert.equal((await pool!.query("select 1 from core.events")).rowCount, 0);
    const ok = await asModule(pub, (tx) => tx.query("select core.publish_event('created', '{}'::jsonb) as id"));
    assert.equal(ok.rowCount, 1);
    await pool!.query("delete from core.events");
    await pool!.query("delete from core.jobs");
  });

  test("the check names an event the manifest dropped without an upgrade", async () => {
    const manifest = box.modules.find((m) => m.manifest.id === pub)!.manifest;
    const before = manifest.events;
    manifest.events = [];
    try {
      const problems = await checkDeclarations(pool!, box.registry());
      assert.ok(problems.some((p) => /event .* is in core\.module_declared_events but not declared/.test(p)), problems.join(" | "));
    } finally {
      manifest.events = before;
    }
  });

  test("the check names a difference when a manifest changed without an upgrade", async () => {
    const manifest = box.modules.find((m) => m.manifest.id === sub)!.manifest;
    const before = manifest.subscriptions;
    manifest.subscriptions = [];
    try {
      const problems = await checkDeclarations(pool!, box.registry());
      assert.equal(problems.length, 1);
      assert.match(problems[0]!, /subscription .* is in core\.event_subscriptions but not declared/);
    } finally {
      manifest.subscriptions = before;
    }
  });
});

describe("publishing an event from the module's login", () => {
  test("writes the event as the module and queues the subscriber in the same transaction", async () => {
    const { id } = await asModule(pub, (tx) => events().publish(pub, "created", { n: 1 }, { tx }));
    const event = await pool!.query("select module_id, type, payload from core.events where id = $1", [id]);
    assert.deepEqual(event.rows[0], { module_id: pub, type: `${pub}.created`, payload: { n: 1 } });
    const queued = await pool!.query("select module_id, name, max_attempts, timeout_seconds, enqueued_by, payload from core.jobs");
    assert.equal(queued.rowCount, 1);
    assert.deepEqual([queued.rows[0].module_id, queued.rows[0].name, queued.rows[0].max_attempts, queued.rows[0].timeout_seconds, queued.rows[0].enqueued_by], [sub, "on_created", 2, 15, `event:${pub}`]);
    assert.equal(queued.rows[0].payload.event.id, id);
    assert.equal(queued.rows[0].payload.event.type, `${pub}.created`);
  });

  test("a rollback removes the event and the queued job together", async () => {
    await asModule(pub, (tx) => events().publish(pub, "created", { n: 1 }, { tx }), false);
    assert.equal((await pool!.query("select 1 from core.events")).rowCount, 0);
    assert.equal((await pool!.query("select 1 from core.jobs")).rowCount, 0);
  });

  test("a subscriber that is disabled gets no job", async () => {
    await pool!.query("update core.modules set state = 'disabled' where id = $1", [sub]);
    await asModule(pub, (tx) => events().publish(pub, "created", null, { tx }));
    assert.equal((await pool!.query("select 1 from core.jobs")).rowCount, 0);
  });

  test("a module that is disabled cannot publish", async () => {
    await pool!.query("update core.modules set state = 'disabled' where id = $1", [pub]);
    await assert.rejects(asModule(pub, (tx) => events().publish(pub, "created", null, { tx })), (e) => e instanceof EventError && /is not enabled/.test(e.message));
  });

  test("the module is the login's, not an argument: asking to publish as another module still writes as itself", async () => {
    // The service argument names `other`, but the function reads the login: the event type starts with the login's module.
    await assert.rejects(asModule(other, (tx) => events().publish(other, "created", null, { tx })), /does not declare the event/);
    const result = await asModule(pub, async (tx) => tx.query("select core.publish_event('created', '{}'::jsonb) as id"));
    const row = await pool!.query("select module_id, type from core.events where id = $1", [result.rows[0].id]);
    assert.deepEqual(row.rows[0], { module_id: pub, type: `${pub}.created` });
  });

  test("the login cannot write to core.events or core.jobs directly", async () => {
    await assert.rejects(asModule(pub, (tx) => tx.query("insert into core.events (module_id, type, payload) values ('x', 'x.y', '{}')")), /permission denied/);
    await assert.rejects(asModule(pub, (tx) => tx.query("insert into core.jobs (module_id, name, max_attempts, timeout_seconds, enqueued_by) values ('x', 'y', 1, 1, 'z')")), /permission denied/);
  });
});

describe("queueing a job from the module's login", () => {
  test("queues the job as the module with the limits of its declaration", async () => {
    const { id, deduplicated } = await asModule(pub, (tx) => jobs().enqueue(pub, "own", { a: 1 }, {}, "module", tx));
    assert.equal(deduplicated, false);
    const row = await pool!.query("select module_id, name, max_attempts, timeout_seconds, enqueued_by, payload from core.jobs where id = $1", [id]);
    assert.deepEqual(row.rows[0], { module_id: pub, name: "own", max_attempts: 3, timeout_seconds: 20, enqueued_by: "module", payload: { a: 1 } });
  });

  test("a dedupe key returns the active job instead of adding another", async () => {
    const first = await asModule(pub, (tx) => jobs().enqueue(pub, "own", null, { dedupeKey: "k1" }, "module", tx));
    const second = await asModule(pub, (tx) => jobs().enqueue(pub, "own", null, { dedupeKey: "k1" }, "module", tx));
    assert.deepEqual([second.id, second.deduplicated], [first.id, true]);
    assert.equal((await pool!.query("select 1 from core.jobs")).rowCount, 1);
  });

  test("refuses a job the module does not declare, an oversized payload and a bad dedupe key, even called directly", async () => {
    await assert.rejects(asModule(pub, (tx) => tx.query("select * from core.enqueue_job('nope', '{}'::jsonb, now(), null)")), /does not declare the job/);
    await assert.rejects(asModule(pub, (tx) => tx.query("select * from core.enqueue_job('own', to_jsonb(repeat('x', 70000)), now(), null)")), /over 64 KiB/);
    await assert.rejects(asModule(pub, (tx) => tx.query("select * from core.enqueue_job('own', '{}'::jsonb, now(), '!bad')")), /dedupeKey is not valid/);
    await assert.rejects(asModule(pub, (tx) => tx.query("select * from core.enqueue_job('own', '{}'::jsonb, now() + interval '31 days', null)")), /30 days/);
    await assert.rejects(asModule(pub, (tx) => jobs().enqueue(pub, "nope", null, {}, "module", tx)), (e) => e instanceof JobError);
  });

  test("a job of another module's name is not reachable: the function only looks at the login's own declarations", async () => {
    // `other` declares "own" too, with default limits; the login of `pub` gets pub's limits, never other's.
    const { id } = await asModule(pub, (tx) => jobs().enqueue(pub, "own", null, {}, "module", tx));
    const row = await pool!.query("select module_id, max_attempts from core.jobs where id = $1", [id]);
    assert.deepEqual(row.rows[0], { module_id: pub, max_attempts: 3 });
  });
});

describe("recording a file from the module's login", () => {
  test("stores the bytes through the platform and records the row as the module", async () => {
    const meta = await asModule(pub, (tx) => files().put(pub, { name: "a.txt", data: new TextEncoder().encode("hello") }, { tx }));
    const row = await pool!.query("select module_id, name, size from core.files where id = $1", [meta.id]);
    assert.deepEqual(row.rows[0], { module_id: pub, name: "a.txt", size: "5" });
  });

  test("a rollback leaves no row", async () => {
    await asModule(pub, (tx) => files().put(pub, { name: "a.txt", data: new TextEncoder().encode("hello") }, { tx }), false);
    assert.equal((await pool!.query("select 1 from core.files")).rowCount, 0);
  });

  test("the login cannot insert into core.files, and a disabled module cannot record", async () => {
    await assert.rejects(asModule(pub, (tx) => tx.query("insert into core.files (id, module_id, name, content_type, size, sha256) values (gen_random_uuid(), 'x', 'n', 'text/plain', 1, repeat('a', 64))")), /permission denied/);
    await pool!.query("update core.modules set state = 'disabled' where id = $1", [pub]);
    await assert.rejects(asModule(pub, (tx) => files().put(pub, { name: "a.txt", data: new TextEncoder().encode("hello") }, { tx })), (e) => e instanceof FileError && /is not enabled/.test(e.message));
  });
});
