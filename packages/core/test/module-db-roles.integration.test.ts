import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import { DbAccessError } from "@modunexo/sdk";
import { ModuleDbService } from "../src/data/module-db.ts";
import { ModuleRoles } from "../src/data/module-roles.ts";
import { createPool } from "../src/pool.ts";
import { migrate } from "../src/runner.ts";
import { createScratchDatabase } from "../src/testing.ts";
import { Sandbox } from "./sandbox.ts";

let pool: pg.Pool | undefined;
let roles: ModuleRoles;
let box: Sandbox;
let skipReason: string | undefined;
let setup = "";
let dropScratch: (() => Promise<void>) | undefined;
let a = "";
let b = "";
let c = "";
const schemaOf = (id: string) => box.modules.find((m) => m.manifest.id === id)!.manifest.schema;

before(async () => {
  try {
    await setUp();
  } catch (error) {
    setup = `${(error as Error).message} | ${((error as Error).cause as Error | undefined)?.message ?? ""}`.replace(/\s+/g, " ");
  }
});

async function setUp(): Promise<void> {
  const scratch = await createScratchDatabase();
  if (!scratch.url) {
    skipReason = scratch.skipReason;
    return;
  }
  dropScratch = scratch.drop;
  pool = createPool(scratch.url);
  roles = new ModuleRoles({ pool, connectionString: scratch.url, masterKey: "k".repeat(40) });
  box = new Sandbox(pool);
  const mb = box.add();
  b = mb.manifest.id;
  mb.write("0001_t.sql", "create table notes (id serial primary key, body text); insert into notes (body) values ('from b');");
  const ma = box.add({ [b]: "^1.0.0" });
  a = ma.manifest.id;
  ma.write("0001_t.sql", "create table items (id serial primary key, name text); insert into items (name) values ('from a');");
  const mc = box.add();
  c = mc.manifest.id;
  mc.write("0001_t.sql", "create table secrets (id serial primary key, v text); insert into secrets (v) values ('from c');");
  await migrate(pool, box.registry(), { moduleRoles: roles });
  await pool.query("insert into core.modules (id, state, installed_version) values ($1, 'enabled', '1.0.0'), ($2, 'enabled', '1.0.0'), ($3, 'enabled', '1.0.0')", [a, b, c]);
}

after(async () => {
  if (pool) {
    await pool.query("delete from core.modules where id = any($1)", [[a, b, c]]);
    for (const { manifest } of box.modules) {
      await pool.query(`drop schema if exists "${manifest.schema}" cascade`).catch(() => undefined);
      await roles.drop(manifest.schema).catch(() => undefined);
    }
    await roles.close();
    await box.cleanup();
    await pool.end();
  }
  await dropScratch?.();
});

const test = (name: string, run: () => Promise<void>) =>
  it(name, async (t) => {
    if (!pool) return t.skip(skipReason);
    if (setup !== "") throw new Error(`SETUP ${setup}`);
    await run();
  });

const service = () => new ModuleDbService(pool!, box.registry(), { moduleRoles: roles });

describe("getDb on the module's own login", () => {
  test("a module reads and writes its own schema through its handle", async () => {
    const db = service().forModule(a);
    await db.query("insert into items (name) values ($1)", ["second"]);
    const { rows } = await db.query("select name from items order by id");
    assert.deepEqual(rows.map((r) => r.name), ["from a", "second"]);
  });

  test("it cannot reach core or a module it does not depend on, even by qualified name", async () => {
    const db = service().forModule(a);
    await assert.rejects(db.query("select * from core.modules"), /permission denied/);
    await assert.rejects(db.query("select * from core.schema_migrations"), /permission denied/);
    await assert.rejects(db.query(`select * from "${schemaOf(c)}".secrets`), /permission denied/);
    await assert.rejects(db.query(`insert into "${schemaOf(b)}".notes (body) values ('x')`), /permission denied/);
  });

  test("set_config('role', ...) does not bring back the platform's rights", async () => {
    const db = service().forModule(a);
    await db.query("select set_config('role', 'none', false)").catch(() => undefined);
    await assert.rejects(db.query("select query_to_xml('select * from core.modules', true, false, '')"), /permission denied/);
    await assert.rejects(db.query(`select query_to_xml('select * from "${schemaOf(c)}".secrets', true, false, '')`), /permission denied/);
  });

  test("reader() of a dependency reads it and nothing more: a write is refused by the database", async () => {
    const reader = service().forModule(a).reader(b);
    assert.deepEqual((await reader.query("select body from notes")).rows, [{ body: "from b" }]);
    await assert.rejects(reader.query("insert into notes (body) values ('x')"), /read-only transaction|permission denied/);
  });

  test("reader() of a module that is not in dependsOn is refused", async () => {
    assert.throws(() => service().forModule(a).reader(c), (e) => e instanceof DbAccessError && e.code === "not-a-dependency");
    assert.throws(() => service().forModule(b).reader(a), (e) => e instanceof DbAccessError && e.code === "not-a-dependency");
  });

  test("a table the dependency creates later is readable too", async () => {
    await service().forModule(b).query("create table later (n int)");
    await service().forModule(b).query("insert into later values (7)");
    assert.deepEqual((await service().forModule(a).reader(b).query("select n from later")).rows, [{ n: 7 }]);
  });

  test("a module that is disabled has no handle", async () => {
    await pool!.query("update core.modules set state = 'disabled' where id = $1", [a]);
    try {
      await assert.rejects(service().forModule(a).query("select 1"), (e) => e instanceof DbAccessError && e.code === "not-enabled");
    } finally {
      await pool!.query("update core.modules set state = 'enabled' where id = $1", [a]);
    }
  });

  test("readOwn runs read-only as the module and cannot see core", async () => {
    const own = service().readOwn(a);
    assert.equal((await own.query("select count(*)::int as n from items")).rows[0]!.n >= 1, true);
    await assert.rejects(own.query("insert into items (name) values ('x')"), /read-only transaction/);
    await assert.rejects(own.query("select * from core.modules"), /permission denied/);
    await assert.rejects(own.query("select query_to_xml('select * from core.modules', true, false, '')"), /permission denied/);
  });

  test("dropping a dependency from dependsOn takes the read away on the next apply", async () => {
    const manifest = box.modules.find((m) => m.manifest.id === a)!.manifest;
    const declared = manifest.dependsOn;
    manifest.dependsOn = {};
    try {
      await migrate(pool!, box.registry(), { moduleRoles: roles });
      await assert.rejects(roles.pool(manifest.schema).then((p) => p.query(`select * from "${schemaOf(b)}".notes`)), /permission denied/);
    } finally {
      manifest.dependsOn = declared;
      await migrate(pool!, box.registry(), { moduleRoles: roles });
    }
    assert.deepEqual((await service().forModule(a).reader(b).query("select body from notes")).rows, [{ body: "from b" }]);
  });
});
