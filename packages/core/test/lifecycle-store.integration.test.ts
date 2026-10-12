import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import { Registry } from "../src/registry.ts";
import { migrate } from "../src/runner.ts";
import { appendEvent, deleteState, readEvents, readSchemas, readStates, upsertState } from "../src/lifecycle/store.ts";
import { createPool } from "../src/pool.ts";
import { createScratchDatabase, openTestPool } from "../src/testing.ts";

let pool: pg.Pool | undefined;
let skipReason: string | undefined;
const created: string[] = [];

before(async () => {
  ({ pool, skipReason } = await openTestPool());
  if (pool) {
    const registry = new Registry();
    registry.registerCore();
    await migrate(pool, registry);
  }
});

after(async () => {
  if (pool) {
    await pool.query("delete from core.modules where id = any($1)", [created]);
    await pool.query("delete from core.module_events where module_id = any($1)", [created]);
    await pool.end();
  }
});

const test = (name: string, run: (id: string) => Promise<void>) =>
  it(name, async (t) => {
    if (!pool) return t.skip(skipReason);
    const id = `t-${randomBytes(4).toString("hex")}`;
    created.push(id);
    await run(id);
  });

const columns = async (table: string) =>
  (await pool!.query("select column_name from information_schema.columns where table_schema = 'core' and table_name = $1 order by ordinal_position", [table])).rows.map(
    (r) => r.column_name as string,
  );

describe("core lifecycle tables (migration 0002)", () => {
  test("core.modules holds only what the manifest does not already say", async () => {
    assert.deepEqual(await columns("modules"), ["id", "state", "installed_version", "installed_at", "updated_at"]);
  });

  test("core.module_events has the audit columns", async () => {
    assert.deepEqual(await columns("module_events"), ["id", "module_id", "action", "from_state", "to_state", "version", "outcome", "detail", "occurred_at"]);
  });

  test("the migration is recorded in the core history", async () => {
    const files = (await pool!.query("select filename from core.schema_migrations where module_id = 'core' order by filename")).rows.map((r) => r.filename);
    assert.ok(files.includes("0002_lifecycle_state.sql"), files.join(", "));
  });

  test("a module that is merely available has no row: state is enabled or disabled only", async (id) => {
    await assert.rejects(pool!.query("insert into core.modules (id, state, installed_version) values ($1, 'available', '1.0.0')", [id]), /check constraint/);
    await assert.rejects(pool!.query("insert into core.modules (id, state, installed_version) values ($1, 'installed', '1.0.0')", [id]), /check constraint/);
  });

  test("events accept only the known actions, states and outcomes", async (id) => {
    const insert = (action: string, from: string, to: string, outcome: string) =>
      pool!.query("insert into core.module_events (module_id, action, from_state, to_state, version, outcome) values ($1, $2, $3, $4, '1.0.0', $5)", [id, action, from, to, outcome]);
    await assert.rejects(insert("restart", "available", "enabled", "ok"), /check constraint/);
    await assert.rejects(insert("install", "missing", "enabled", "ok"), /check constraint/);
    await assert.rejects(insert("install", "available", "gone", "ok"), /check constraint/);
    await assert.rejects(insert("install", "available", "enabled", "maybe"), /check constraint/);
    await insert("install", "available", "enabled", "ok");
  });
});

describe("lifecycle state store", () => {
  test("reads nothing for an unknown module and every row otherwise", async (id) => {
    assert.equal((await readStates(pool!)).has(id), false);
    await upsertState(pool!, { id, state: "enabled", installedVersion: "1.0.0" });
    assert.deepEqual((await readStates(pool!)).get(id), { id, state: "enabled", installedVersion: "1.0.0" });
  });

  test("upsert updates state and version in place and moves updated_at, not installed_at", async (id) => {
    await upsertState(pool!, { id, state: "enabled", installedVersion: "1.0.0" });
    const before = (await pool!.query("select installed_at, updated_at from core.modules where id = $1", [id])).rows[0];
    await new Promise((resolve) => setTimeout(resolve, 15));
    await upsertState(pool!, { id, state: "disabled", installedVersion: "1.1.0" });
    const after = (await pool!.query("select installed_at, updated_at, state, installed_version from core.modules where id = $1", [id])).rows[0];
    assert.equal(after.state, "disabled");
    assert.equal(after.installed_version, "1.1.0");
    assert.equal(after.installed_at.getTime(), before.installed_at.getTime());
    assert.ok(after.updated_at.getTime() > before.updated_at.getTime());
  });

  test("delete removes the row and tolerates a missing one", async (id) => {
    await upsertState(pool!, { id, state: "enabled", installedVersion: "1.0.0" });
    await deleteState(pool!, id);
    await deleteState(pool!, id);
    assert.equal((await readStates(pool!)).has(id), false);
  });

  test("events are appended in order and survive the removal of the module row", async (id) => {
    await upsertState(pool!, { id, state: "enabled", installedVersion: "1.0.0" });
    await appendEvent(pool!, { moduleId: id, action: "install", fromState: "available", toState: "enabled", version: "1.0.0", outcome: "ok" });
    await appendEvent(pool!, { moduleId: id, action: "uninstall", fromState: "enabled", toState: "available", version: "1.0.0", outcome: "failed", detail: "onUninstall: boom" });
    await deleteState(pool!, id);

    const events = await readEvents(pool!, id);
    assert.deepEqual(
      events.map((e) => [e.action, e.fromState, e.toState, e.version, e.outcome, e.detail]),
      [
        ["install", "available", "enabled", "1.0.0", "ok", null],
        ["uninstall", "enabled", "available", "1.0.0", "failed", "onUninstall: boom"],
      ],
    );
    assert.ok(events[0]!.id < events[1]!.id);
    assert.ok(events[0]!.occurredAt instanceof Date);
  });

  test("readEvents without an id returns events of every module", async (id) => {
    await appendEvent(pool!, { moduleId: id, action: "enable", fromState: "disabled", toState: "enabled", version: "1.0.0", outcome: "ok" });
    assert.ok((await readEvents(pool!)).some((e) => e.moduleId === id));
  });

  test("works on a single connection, so several writes can share a transaction", async (id) => {
    const client = await pool!.connect();
    try {
      await client.query("begin");
      await upsertState(client, { id, state: "enabled", installedVersion: "1.0.0" });
      await appendEvent(client, { moduleId: id, action: "install", fromState: "available", toState: "enabled", version: "1.0.0", outcome: "ok" });
      await client.query("rollback");
    } finally {
      client.release();
    }
    assert.equal((await readStates(pool!)).has(id), false);
    assert.deepEqual(await readEvents(pool!, id), []);
  });

  test("lists the schemas that exist", async () => {
    const schemas = await readSchemas(pool!);
    assert.ok(schemas.has("core"));
    assert.ok(!schemas.has("no_such_schema_ever"));
  });
});

describe("lifecycle state store: before the core migration", () => {
  it("reads no states when the lifecycle tables do not exist yet", async (t) => {
    const scratch = await createScratchDatabase();
    if (!scratch.url) return t.skip(scratch.skipReason);
    const fresh = createPool(scratch.url);
    try {
      assert.deepEqual([...(await readStates(fresh))], []);
    } finally {
      await fresh.end();
      await scratch.drop();
    }
  });
});
