import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import { ModuleDbService } from "../src/data/module-db.ts";
import { migrate } from "../src/runner.ts";
import { createPool } from "../src/pool.ts";
import { createScratchDatabase } from "../src/testing.ts";
import { Sandbox } from "./sandbox.ts";

let pool: pg.Pool | undefined;
let skipReason: string | undefined;
let drop: (() => Promise<void>) | undefined;
let box: Sandbox;
let mine: string;
let theirs: string;
let mineSchema: string;
let theirsSchema: string;

before(async () => {
  const scratch = await createScratchDatabase();
  if (scratch.url === undefined) {
    skipReason = scratch.skipReason;
    return;
  }
  drop = scratch.drop;
  pool = createPool(scratch.url);
  box = new Sandbox(pool);
  const first = box.add();
  const second = box.add();
  for (const mod of [first, second]) mod.write("0001_init.sql", "create table items (id serial primary key, label text not null);");
  mine = first.manifest.id;
  theirs = second.manifest.id;
  mineSchema = first.manifest.schema;
  theirsSchema = second.manifest.schema;
  await migrate(pool, box.registry());
  for (const id of [mine, theirs]) {
    await pool.query("delete from core.modules where id = $1", [id]);
    await pool.query("insert into core.modules (id, state, installed_version) values ($1, 'enabled', '1.0.0')", [id]);
  }
  await pool.query(`insert into "${mineSchema}".items (label) values ('first'), ('second')`);
  await pool.query(`insert into "${theirsSchema}".items (label) values ('secret of the other module')`);
});

after(async () => {
  if (pool) {
    await box.cleanup();
    await pool.end();
  }
  await drop?.();
});

const guard = (name: string, run: () => Promise<void>) =>
  it(name, async (t) => {
    if (!pool) return t.skip(skipReason);
    await run();
  });

const fresh = () => new ModuleDbService(pool!, box.registry());

describe("ModuleDbService.readOwn: the platform's statements for a module reach that module's schema only", () => {
  guard("reads the module's own tables by their plain name", async () => {
    const result = await fresh().readOwn(mine).query<{ n: number }>("select count(*)::int as n from items");
    assert.equal(result.rows[0]!.n, 2);
  });

  guard("refuses to read the platform's tables, even by their qualified name", async () => {
    await assert.rejects(fresh().readOwn(mine).query("select * from core.modules"), /permission denied/);
    await assert.rejects(fresh().readOwn(mine).query("select count(*) from core.events"), /permission denied/);
  });

  guard("refuses to read another module's tables, even by their qualified name", async () => {
    await assert.rejects(fresh().readOwn(mine).query(`select label from "${theirsSchema}".items`), /permission denied/);
  });

  guard("refuses to step out of its restriction inside one statement", async () => {
    const sneaky = "select set_config('role', session_user, true), (select count(*) from core.modules)";
    await assert.rejects(fresh().readOwn(mine).query(sneaky), /permission denied/);
    await assert.rejects(fresh().readOwn(mine).query("select set_config('role', 'none', true), (select count(*) from core.modules)"), /permission denied/);
  });

  guard("still refuses a write", async () => {
    await assert.rejects(fresh().readOwn(mine).query("with w as (insert into items (label) values ('x') returning 1) select count(*) from w"), /read-only|permission denied/);
  });

  guard("reads a table a later upgrade creates, without waiting for a restart", async () => {
    const service = fresh();
    await service.readOwn(mine).query("select 1");
    await pool!.query(`create table "${mineSchema}".added_later (n int)`);
    await pool!.query(`insert into "${mineSchema}".added_later values (7)`);
    const result = await service.readOwn(mine).query<{ n: number }>("select n from added_later");
    assert.equal(result.rows[0]!.n, 7);
  });

  guard("sets the role up once even when the first reads arrive together", async () => {
    const service = fresh();
    const results = await Promise.all(Array.from({ length: 8 }, () => service.readOwn(theirs).query<{ n: number }>("select count(*)::int as n from items")));
    assert.deepEqual(results.map((result) => result.rows[0]!.n), Array(8).fill(1));
    const { rows } = await pool!.query("select count(*)::int as n from pg_roles where rolname like 'mnx_ro_%' and rolname = any($1)", [[`mnx_ro_${theirsSchema}`]]);
    assert.equal(rows[0].n, 1);
  });

  guard("leaves the role with no right to log in", async () => {
    await fresh().readOwn(mine).query("select 1");
    const { rows } = await pool!.query("select rolcanlogin, rolsuper, rolcreaterole, rolcreatedb from pg_roles where rolname = $1", [`mnx_ro_${mineSchema}`]);
    assert.deepEqual(rows, [{ rolcanlogin: false, rolsuper: false, rolcreaterole: false, rolcreatedb: false }]);
  });
});

describe("ModuleDbService: what a module's own code is given does not change", () => {
  guard("the module's own handle still reads and writes its schema, and a declared dependency is still read-only", async () => {
    const db = fresh().forModule(mine);
    await db.query("insert into items (label) values ('kept')");
    const { rows } = await db.query<{ n: number }>("select count(*)::int as n from items");
    assert.equal(rows[0]!.n, 3);
    await pool!.query(`delete from "${mineSchema}".items where label = 'kept'`);
  });
});
