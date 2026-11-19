import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import { ModuleRoles, moduleRoleName } from "../src/data/module-roles.ts";
import { createPool } from "../src/pool.ts";
import { migrate } from "../src/runner.ts";
import { createScratchDatabase } from "../src/testing.ts";
import { Sandbox } from "./sandbox.ts";

const KEY = "k".repeat(40);

let pool: pg.Pool | undefined;
let roles: ModuleRoles | undefined;
let skipReason: string | undefined;
let drop: (() => Promise<void>) | undefined;
const schemas: string[] = [];

before(async () => {
  const scratch = await createScratchDatabase();
  if (scratch.url === undefined) {
    skipReason = scratch.skipReason;
    return;
  }
  drop = scratch.drop;
  pool = createPool(scratch.url);
  roles = new ModuleRoles({ pool, connectionString: scratch.url, masterKey: KEY });
});

after(async () => {
  if (pool && roles) {
    for (const schema of schemas) {
      await pool.query(`drop schema if exists "${schema}" cascade`).catch(() => undefined);
      await roles.drop(schema).catch(() => undefined);
    }
    await roles.close();
    await pool.end();
  }
  await drop?.();
});

const test = (name: string, run: (box: Sandbox, roles: ModuleRoles) => Promise<void>) =>
  it(name, async (t) => {
    if (!pool || !roles) return t.skip(skipReason);
    const box = new Sandbox(pool);
    try {
      await run(box, roles);
    } finally {
      for (const { manifest } of box.modules) schemas.push(manifest.schema);
      await box.cleanup();
    }
  });

describe("migrations on the module's own login", () => {
  test("a module's migration runs as its role: the schema and tables belong to it, and the record names the module", async (box, r) => {
    const mod = box.add();
    mod.write("0001_items.sql", "create table items (id bigserial primary key, name text not null);");
    await migrate(pool!, box.registry(), { moduleRoles: r });

    const role = moduleRoleName(mod.manifest.schema);
    const owner = await pool!.query(
      "select (select nspowner::regrole::text from pg_namespace where nspname = $1) as schema_owner, (select tableowner from pg_tables where schemaname = $1 and tablename = 'items') as table_owner",
      [mod.manifest.schema],
    );
    assert.deepEqual([owner.rows[0].schema_owner, owner.rows[0].table_owner], [role, role]);
    const recorded = await pool!.query("select filename from core.schema_migrations where module_id = $1", [mod.manifest.id]);
    assert.deepEqual(recorded.rows.map((x) => x.filename), ["0001_items.sql"]);
  });

  test("a migration that names core is refused by the database, rolled back and not recorded", async (box, r) => {
    const mod = box.add();
    mod.write("0001_ok.sql", "create table ok (n int);");
    mod.write("0002_evil.sql", "create table ok2 (n int); create table core.evil (n int);");
    await assert.rejects(migrate(pool!, box.registry(), { moduleRoles: r }), /0002_evil\.sql failed: .*permission denied/);

    assert.equal((await pool!.query("select 1 from pg_tables where schemaname = 'core' and tablename = 'evil'")).rowCount, 0);
    assert.equal((await pool!.query("select 1 from pg_tables where schemaname = $1 and tablename = 'ok2'", [mod.manifest.schema])).rowCount, 0);
    const recorded = await pool!.query("select filename from core.schema_migrations where module_id = $1", [mod.manifest.id]);
    assert.deepEqual(recorded.rows.map((x) => x.filename), ["0001_ok.sql"]);
  });

  test("a migration cannot read or write another module's schema", async (box, r) => {
    const first = box.add();
    first.write("0001_secret.sql", "create table secret (n int); insert into secret values (1);");
    await migrate(pool!, box.registry(), { moduleRoles: r });
    const second = box.add();
    second.write("0001_peek.sql", `select * from "${first.manifest.schema}".secret;`);
    await assert.rejects(migrate(pool!, box.registry(), { moduleRoles: r }), /0001_peek\.sql failed: .*permission denied/);
    assert.equal((await pool!.query("select 1 from core.schema_migrations where module_id = $1", [second.manifest.id])).rowCount, 0);
  });

  test("a migration cannot create an extension", async (box, r) => {
    box.add().write("0001_ext.sql", "create extension if not exists pgcrypto;");
    await assert.rejects(migrate(pool!, box.registry(), { moduleRoles: r }), /0001_ext\.sql failed: .*(permission denied|must be)/);
  });

  test("a migration cannot return to the platform's rights with set_config('role', ...)", async (box, r) => {
    box.add().write("0001_back.sql", "select set_config('role', 'none', true); create table core.evil2 (n int);");
    await assert.rejects(migrate(pool!, box.registry(), { moduleRoles: r }), /0001_back\.sql failed/);
    assert.equal((await pool!.query("select 1 from pg_tables where schemaname = 'core' and tablename = 'evil2'")).rowCount, 0);
  });

  test("the module's login can reach nothing in core but record_migration, and that records only for itself", async (box, r) => {
    const a = box.add();
    const b = box.add();
    a.write("0001_a.sql", "create table a (n int);");
    b.write("0001_b.sql", "create table b (n int);");
    await migrate(pool!, box.registry(), { moduleRoles: r });

    const poolA = await r.pool(a.manifest.schema);
    for (const sql of ["select * from core.module_roles", "select * from core.schema_migrations", "insert into core.schema_migrations (module_id, filename, checksum) values ('x', 'y', 'z')", "delete from core.schema_migrations"]) {
      await assert.rejects(poolA.query(sql), /permission denied/, sql);
    }
    await poolA.query("select core.record_migration('0002_forged.sql', 'abc')");
    const forged = await pool!.query("select module_id from core.schema_migrations where filename = '0002_forged.sql'");
    assert.deepEqual(forged.rows.map((x) => x.module_id), [a.manifest.id]);
    await assert.rejects(pool!.query("select core.record_migration('0003.sql', 'x')"), /is not a module login/);
  });

  test("the core's own migrations stay on the platform connection, and a rerun applies nothing", async (box, r) => {
    box.add().write("0001_x.sql", "create table x (n int);");
    const first = await migrate(pool!, box.registry(), { moduleRoles: r });
    assert.deepEqual(first.applied.map((a) => a.moduleId).filter((id) => id !== "core"), [box.modules[0]!.manifest.id]);
    const core = await pool!.query("select 1 from core.schema_migrations where module_id = 'core' and filename = '0015_module_roles.sql'");
    assert.equal(core.rowCount, 1);
    const second = await migrate(pool!, box.registry(), { moduleRoles: r });
    assert.deepEqual(second.applied, []);
  });

  test("without moduleRoles a module still migrates on the platform connection, as before", async (box) => {
    const mod = box.add();
    mod.write("0001_x.sql", "create table x (n int);");
    await migrate(pool!, box.registry());
    const owner = await pool!.query("select tableowner from pg_tables where schemaname = $1 and tablename = 'x'", [mod.manifest.schema]);
    assert.notEqual(owner.rows[0].tableowner, moduleRoleName(mod.manifest.schema));
  });
});
