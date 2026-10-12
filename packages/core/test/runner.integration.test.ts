import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { basename, dirname } from "node:path";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import { MIGRATION_LOCK_NAME, migrate, migrateModule } from "../src/runner.ts";
import { Registry } from "../src/registry.ts";
import { openTestPool } from "../src/testing.ts";
import { Sandbox } from "./sandbox.ts";

let pool: pg.Pool | undefined;
let skipReason: string | undefined;

before(async () => {
  ({ pool, skipReason } = await openTestPool());
});

after(async () => {
  await pool?.end();
});

const test = (name: string, run: (box: Sandbox) => Promise<void>) =>
  it(name, async (t) => {
    if (!pool) return t.skip(skipReason);
    const box = new Sandbox(pool);
    try {
      await run(box);
    } finally {
      await box.cleanup();
    }
  });

const appliedBy = (result: { applied: { moduleId: string; filename: string }[] }, id: string) =>
  result.applied.filter((a) => a.moduleId === id).map((a) => a.filename);

describe("migrate (integration): the core", () => {
  test("bootstraps the core schema with only the tracking table, and records its own migration", async () => {
    const registry = new Registry();
    registry.registerCore();
    await migrate(pool!, registry);

    const tables = await pool!.query("select table_name from information_schema.tables where table_schema = 'core' order by 1");
    assert.deepEqual(tables.rows.map((r) => r.table_name), ["schema_migrations"]);
    const tracked = await pool!.query("select filename from core.schema_migrations where module_id = 'core' order by filename");
    assert.equal(tracked.rows[0].filename, "0001_init.sql");
  });

  test("refuses to run when the core module is not registered", async (box) => {
    box.add();
    const registry = new Registry();
    registry.register(box.modules[0]!.manifest);
    await assert.rejects(migrate(pool!, registry), /core module is not registered/);
  });
});

describe("migrate (integration): modules", () => {
  test("creates the module schema, applies files in order inside it and records them", async (box) => {
    const mod = box.add();
    mod.write("0002_add_row.sql", "insert into items (name) values ('x');");
    mod.write("0001_create_items.sql", "create table items (name text not null);");

    const result = await migrate(pool!, box.registry());

    assert.deepEqual(appliedBy(result, mod.manifest.id), ["0001_create_items.sql", "0002_add_row.sql"]);
    const rows = await pool!.query(`select name from "${mod.manifest.schema}".items`);
    assert.equal(rows.rowCount, 1);
    const recorded = await pool!.query(
      "select filename, checksum, applied_at from core.schema_migrations where module_id = $1 order by filename",
      [mod.manifest.id],
    );
    assert.equal(recorded.rowCount, 2);
    assert.match(recorded.rows[0].checksum, /^[0-9a-f]{64}$/);
    assert.ok(recorded.rows[0].applied_at instanceof Date);
  });

  test("a second run applies nothing, and a later run applies only new files", async (box) => {
    const mod = box.add();
    mod.write("0001_create_items.sql", "create table items (name text);");
    await migrate(pool!, box.registry());
    assert.deepEqual(appliedBy(await migrate(pool!, box.registry()), mod.manifest.id), []);

    mod.write("0002_more.sql", "alter table items add column extra text;");
    assert.deepEqual(appliedBy(await migrate(pool!, box.registry()), mod.manifest.id), ["0002_more.sql"]);
  });

  test("applies modules in dependency order", async (box) => {
    const base = box.add();
    const app = box.add({ [base.manifest.id]: "*" });
    base.write("0001_create_items.sql", "create table items (id int primary key);");
    app.write("0001_link.sql", `create table links (item int references "${base.manifest.schema}".items (id));`);

    const result = await migrate(pool!, box.registry());
    const own = result.applied.filter((a) => a.moduleId === base.manifest.id || a.moduleId === app.manifest.id);
    assert.deepEqual(own.map((a) => a.moduleId), [base.manifest.id, app.manifest.id]);
  });

  test("rejects an invalid dependency graph before touching the database", async (box) => {
    const mod = box.add({ ghost: "*" });
    mod.write("0001_a.sql", "create table a (x int);");
    await assert.rejects(migrate(pool!, box.registry()), /depends on unknown module "ghost"/);
    const schema = await pool!.query("select 1 from information_schema.schemata where schema_name = $1", [mod.manifest.schema]);
    assert.equal(schema.rowCount, 0);
  });

  test("resolves a relative migrationsDir against the module directory it is given", async (box) => {
    const mod = box.add();
    mod.write("0001_a.sql", "create table a (x int);");
    const relative = { ...mod.manifest, migrationsDir: "db" };
    const registry = new Registry();
    registry.registerCore();
    registry.register(relative);

    await assert.rejects(migrate(pool!, registry), /relative migrationsDir "db".*no module directory/);
    const moved = { ...relative, migrationsDir: basename(mod.dir) };
    const second = new Registry();
    second.registerCore();
    second.register(moved);
    const result = await migrate(pool!, second, { moduleDirs: { [mod.manifest.id]: dirname(mod.dir) } });
    assert.deepEqual(appliedBy(result, mod.manifest.id), ["0001_a.sql"]);
  });
});

describe("migrate (integration): history guards", () => {
  test("fails loudly when an applied file changed", async (box) => {
    const mod = box.add();
    mod.write("0001_create_items.sql", "create table items (name text);");
    await migrate(pool!, box.registry());
    mod.write("0001_create_items.sql", "create table items (name text, sneaky int);");
    await assert.rejects(migrate(pool!, box.registry()), /"0001_create_items\.sql" was modified after it was applied/);
  });

  test("fails when an applied file is missing from disk", async (box) => {
    const mod = box.add();
    mod.write("0001_a.sql", "create table a (x int);");
    mod.write("0002_b.sql", "create table b (x int);");
    await migrate(pool!, box.registry());
    rmSync(`${mod.dir}/0001_a.sql`);
    await assert.rejects(migrate(pool!, box.registry()), /"0001_a\.sql" was applied but is missing from disk/);
  });

  test("fails when a new file sorts before the latest applied one", async (box) => {
    const mod = box.add();
    mod.write("0002_b.sql", "create table b (x int);");
    await migrate(pool!, box.registry());
    mod.write("0001_a.sql", "create table a (x int);");
    await assert.rejects(migrate(pool!, box.registry()), /"0001_a\.sql" is older than the latest applied migration "0002_b\.sql"/);
  });

  test("rejects duplicate migration numbers", async (box) => {
    const mod = box.add();
    mod.write("0001_a.sql", "select 1;");
    mod.write("0001_b.sql", "select 1;");
    await assert.rejects(migrate(pool!, box.registry()), /duplicate migration number 0001/);
  });
});

describe("migrate (integration): failures", () => {
  test("rolls back a failing file completely, records nothing for it, and names module and file", async (box) => {
    const mod = box.add();
    mod.write("0001_ok.sql", "create table items (name text);");
    mod.write("0002_broken.sql", "create table half_done (a int); select * from does_not_exist;");

    const error = await migrate(pool!, box.registry()).then(
      () => assert.fail("expected the migration to fail"),
      (e: Error) => e,
    );

    assert.match(error.message, new RegExp(`migration ${mod.manifest.id}/0002_broken\\.sql failed`));
    assert.match((error.cause as Error).message, /does_not_exist/, "the original database error is the cause");
    const recorded = await pool!.query("select filename from core.schema_migrations where module_id = $1", [mod.manifest.id]);
    assert.deepEqual(recorded.rows.map((r) => r.filename), ["0001_ok.sql"]);
    const leftover = await pool!.query("select to_regclass($1) as t", [`"${mod.manifest.schema}".half_done`]);
    assert.equal(leftover.rows[0].t, null);
  });

  test("stops at the first failing module and leaves later ones unapplied", async (box) => {
    const first = box.add();
    const second = box.add({ [first.manifest.id]: "*" });
    first.write("0001_bad.sql", "select * from does_not_exist;");
    second.write("0001_a.sql", "create table a (x int);");
    await assert.rejects(migrate(pool!, box.registry()), /does_not_exist/);
    const recorded = await pool!.query("select 1 from core.schema_migrations where module_id = $1", [second.manifest.id]);
    assert.equal(recorded.rowCount, 0);
  });
});

describe("migrate (integration): locking", () => {
  test("concurrent runs apply each file once", async (box) => {
    const mod = box.add();
    mod.write("0001_create_items.sql", "create table items (name text);");
    const registry = box.registry();
    const results = await Promise.all([migrate(pool!, registry), migrate(pool!, registry)]);
    assert.equal(results.flatMap((r) => appliedBy(r, mod.manifest.id)).length, 1);
  });

  test("a held lock makes the run fail after the timeout instead of waiting forever", async (box) => {
    box.add().write("0001_a.sql", "create table a (x int);");
    const holder = await pool!.connect();
    try {
      await holder.query("select pg_advisory_lock(hashtext($1))", [MIGRATION_LOCK_NAME]);
      const started = Date.now();
      await assert.rejects(migrate(pool!, box.registry(), { lockTimeoutMs: 300, lockPollMs: 50 }), /could not acquire the migration lock within 300 ms/);
      assert.ok(Date.now() - started < 3000);
    } finally {
      await holder.query("select pg_advisory_unlock(hashtext($1))", [MIGRATION_LOCK_NAME]);
      holder.release();
    }
  });
});

describe("migrateModule (integration)", () => {
  test("migrates one module (after bootstrapping the core) and leaves the others alone", async (box) => {
    const wanted = box.add();
    const other = box.add();
    wanted.write("0001_a.sql", "create table a (x int);");
    other.write("0001_b.sql", "create table b (x int);");

    const result = await migrateModule(pool!, box.registry(), wanted.manifest.id);

    assert.deepEqual(appliedBy(result, wanted.manifest.id), ["0001_a.sql"]);
    assert.deepEqual(appliedBy(result, other.manifest.id), []);
    const schemas = await pool!.query("select schema_name from information_schema.schemata where schema_name = any($1)", [
      [wanted.manifest.schema, other.manifest.schema],
    ]);
    assert.deepEqual(schemas.rows.map((r) => r.schema_name), [wanted.manifest.schema]);
  });

  test("applies only what is new on a later call, with the same history guards", async (box) => {
    const mod = box.add();
    mod.write("0001_a.sql", "create table a (x int);");
    await migrateModule(pool!, box.registry(), mod.manifest.id);
    mod.write("0002_b.sql", "create table b (x int);");
    assert.deepEqual(appliedBy(await migrateModule(pool!, box.registry(), mod.manifest.id), mod.manifest.id), ["0002_b.sql"]);
    mod.write("0001_a.sql", "create table a (x int, y int);");
    await assert.rejects(migrateModule(pool!, box.registry(), mod.manifest.id), /was modified after it was applied/);
  });

  test("rejects a module the registry does not know", async (box) => {
    await assert.rejects(migrateModule(pool!, box.registry(), "ghost"), /module "ghost" is not registered/);
  });
});
