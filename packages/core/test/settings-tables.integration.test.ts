import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import { purgeModule } from "../src/purge.ts";
import { migrate } from "../src/runner.ts";
import { openTestPool } from "../src/testing.ts";
import { Sandbox } from "./sandbox.ts";

let pool: pg.Pool | undefined;
let skipReason: string | undefined;
let box: Sandbox;

before(async () => {
  ({ pool, skipReason } = await openTestPool());
  if (pool) {
    box = new Sandbox(pool);
    await migrate(pool, box.registry());
  }
});

after(async () => {
  if (pool) {
    await pool.query("delete from core.module_settings where module_id like 't-%'");
    await pool.query("delete from core.settings_events where scope like 't-%'");
    await box.cleanup();
    await pool.end();
  }
});

const test = (name: string, run: () => Promise<void>) =>
  it(name, async (t) => {
    if (!pool) return t.skip(skipReason);
    await run();
  });

const columns = async (table: string) =>
  (await pool!.query("select column_name from information_schema.columns where table_schema = 'core' and table_name = $1 order by ordinal_position", [table])).rows.map((r) => r.column_name as string);

describe("settings tables (migration 0005)", () => {
  test("core.module_settings holds a plain value or an encrypted secret per module and key", async () => {
    assert.deepEqual(await columns("module_settings"), ["module_id", "key", "value", "secret", "updated_at", "updated_by"]);
  });

  test("a row holds exactly one of a value and a secret", async () => {
    const insert = (value: string | null, secret: string | null) =>
      pool!.query("insert into core.module_settings (module_id, key, value, secret, updated_by) values ('t-x', $1, $2::jsonb, $3, 'test')", [
        `k${Math.random()}`,
        value,
        secret,
      ]);
    await assert.rejects(insert(null, null), /check constraint/);
    await assert.rejects(insert('"v"', "v1.a.b.c"), /check constraint/);
    await insert('"v"', null);
    await insert(null, "v1.a.b.c");
    await pool!.query("delete from core.module_settings where module_id = 't-x'");
  });

  test("a module and key appear once", async () => {
    await pool!.query("insert into core.module_settings (module_id, key, value, updated_by) values ('t-y', 'k', '1'::jsonb, 'test')");
    await assert.rejects(pool!.query("insert into core.module_settings (module_id, key, value, updated_by) values ('t-y', 'k', '2'::jsonb, 'test')"), /duplicate key/);
    await pool!.query("delete from core.module_settings where module_id = 't-y'");
  });

  test("core.settings_events records who changed what and when, never a value", async () => {
    assert.deepEqual(await columns("settings_events"), ["id", "scope", "key", "action", "actor", "occurred_at"]);
    await assert.rejects(pool!.query("insert into core.settings_events (scope, key, action, actor) values ('t-z', 'k', 'rewrite', 'test')"), /check constraint/);
    await pool!.query("insert into core.settings_events (scope, key, action, actor) values ('t-z', 'k', 'set', 'test')");
    await pool!.query("delete from core.settings_events where scope = 't-z'");
  });
});

describe("purge and module settings", () => {
  test("purging a module deletes its settings, keeps every other module's, and keeps the audit rows", async () => {
    const mine = box.add();
    const other = box.add();
    const registry = box.registry();
    await migrate(pool!, registry);
    for (const id of [mine.manifest.id, other.manifest.id]) {
      await pool!.query("insert into core.module_settings (module_id, key, value, updated_by) values ($1, 'k', '1'::jsonb, 'test')", [id]);
      await pool!.query("insert into core.settings_events (scope, key, action, actor) values ($1, 'k', 'set', 'test')", [id]);
    }
    await purgeModule(pool!, registry, mine.manifest.id);
    const left = await pool!.query("select module_id from core.module_settings where module_id = any($1) order by 1", [[mine.manifest.id, other.manifest.id]]);
    assert.deepEqual(left.rows.map((r) => r.module_id), [other.manifest.id]);
    const events = await pool!.query("select scope from core.settings_events where scope = any($1) order by 1", [[mine.manifest.id, other.manifest.id]]);
    assert.equal(events.rowCount, 2, "the audit trail outlives the data");
  });
});
