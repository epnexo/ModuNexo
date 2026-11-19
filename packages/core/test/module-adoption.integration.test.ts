import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import { ModuleDbService } from "../src/data/module-db.ts";
import { ModuleRoles, moduleRoleName } from "../src/data/module-roles.ts";
import { LifecycleService } from "../src/lifecycle/index.ts";
import { createPool } from "../src/pool.ts";
import { migrate } from "../src/runner.ts";
import { createScratchDatabase } from "../src/testing.ts";
import { Sandbox } from "./sandbox.ts";

let pool: pg.Pool | undefined;
let roles: ModuleRoles;
let box: Sandbox;
let skipReason: string | undefined;
let dropScratch: (() => Promise<void>) | undefined;

before(async () => {
  const scratch = await createScratchDatabase();
  if (!scratch.url) {
    skipReason = scratch.skipReason;
    return;
  }
  dropScratch = scratch.drop;
  pool = createPool(scratch.url);
  roles = new ModuleRoles({ pool, connectionString: scratch.url, masterKey: "k".repeat(40) });
  box = new Sandbox(pool);
});

after(async () => {
  if (pool) {
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
    await run();
  });

/** The kinds of object a real module's migrations leave behind, created the way the platform did before module logins. */
const OLD_SQL = `
  create type mood as enum ('ok', 'bad');
  create table people (id serial primary key, name text not null, mood mood not null default 'ok');
  create index people_name_idx on people (name);
  create sequence standalone_seq;
  create view people_ok as select id, name from people where mood = 'ok';
  create function greet(p_name text) returns text language sql as $$ select 'hi ' || p_name $$;
  insert into people (name) values ('ada'), ('grace');
`;

const owners = async (schema: string) => {
  const rows = await pool!.query(
    `select 'schema' as kind, nspname as name, pg_get_userbyid(nspowner) as owner from pg_namespace where nspname = $1
     union all select relkind::text, relname, pg_get_userbyid(relowner) from pg_class where relnamespace = $1::regnamespace and relkind in ('r','v','S','i')
     union all select 'function', proname, pg_get_userbyid(proowner) from pg_proc where pronamespace = $1::regnamespace
     union all select 'type', typname, pg_get_userbyid(typowner) from pg_type where typnamespace = $1::regnamespace and typtype = 'e'`,
    [schema],
  );
  return rows.rows as { kind: string; name: string; owner: string }[];
};

describe("adopting a module installed before it had a login", () => {
  test("hands the schema and everything in it to the module's role and keeps the data", async () => {
    const mod = box.add();
    mod.write("0001_old.sql", OLD_SQL);
    await migrate(pool!, box.registry());
    const role = moduleRoleName(mod.manifest.schema);
    assert.ok((await owners(mod.manifest.schema)).every((o) => o.owner !== role), "owned by the platform before");
    await pool!.query("insert into core.modules (id, state, installed_version) values ($1, 'enabled', '1.0.0')", [mod.manifest.id]);
    // The platform made its old read-only role for it, the first time a dashboard figure was read.
    await new ModuleDbService(pool!, box.registry()).readOwn(mod.manifest.id).query("select 1");
    assert.equal((await pool!.query("select 1 from pg_roles where rolname = $1", [`mnx_ro_${mod.manifest.schema}`])).rowCount, 1, "the old role exists before");

    await migrate(pool!, box.registry(), { moduleRoles: roles });

    const after = await owners(mod.manifest.schema);
    assert.ok(after.length >= 8, `kinds seen: ${after.map((o) => o.kind).join(",")}`);
    assert.deepEqual(after.filter((o) => o.owner !== role), []);
    assert.deepEqual((await pool!.query(`select name from "${mod.manifest.schema}".people order by id`)).rows, [{ name: "ada" }, { name: "grace" }]);
  });

  test("the module then works as itself: serial sequences, the view, the function and the enum", async () => {
    const mod = box.modules[0]!;
    const db = new ModuleDbService(pool!, box.registry(), { moduleRoles: roles }).forModule(mod.manifest.id);
    await db.query("insert into people (name, mood) values ($1, 'bad')", ["linus"]);
    assert.deepEqual((await db.query("select id, name from people_ok order by id")).rows.map((r) => r.name), ["ada", "grace"]);
    assert.deepEqual((await db.query("select greet('x') as g")).rows, [{ g: "hi x" }]);
    assert.equal(Number((await db.query("select nextval('standalone_seq') as n")).rows[0]!.n), 1);
    assert.equal(Number((await db.query("select count(*)::int as n from people")).rows[0]!.n), 3);
    await assert.rejects(db.query("select * from core.modules"), /permission denied/);
  });

  test("the old read-only role is gone, and a second run changes nothing", async () => {
    const mod = box.modules[0]!;
    assert.equal((await pool!.query("select 1 from pg_roles where rolname = $1", [`mnx_ro_${mod.manifest.schema}`])).rowCount, 0);
    const before = JSON.stringify(await owners(mod.manifest.schema));
    await migrate(pool!, box.registry(), { moduleRoles: roles });
    assert.equal(JSON.stringify(await owners(mod.manifest.schema)), before);
    assert.equal(Number((await pool!.query(`select count(*)::int as n from "${mod.manifest.schema}".people`)).rows[0].n), 3);
  });

  test("a migration added after the adoption runs on the module's login and can use what was adopted", async () => {
    const mod = box.modules[0]!;
    mod.write("0002_more.sql", "alter table people add column email text; create table notes (id serial primary key, person int references people (id), body text);");
    await migrate(pool!, box.registry(), { moduleRoles: roles });
    const role = moduleRoleName(mod.manifest.schema);
    assert.deepEqual((await owners(mod.manifest.schema)).filter((o) => o.owner !== role), []);
  });
});

describe("uninstalling with purge", () => {
  test("drops the module's schema and its login, and a reinstall starts clean", async () => {
    const mod = box.add();
    mod.write("0001_t.sql", "create table t (n int); insert into t values (1);");
    const service = () => new LifecycleService(pool!, box.registry({ allowUnsupportedPlatform: true }), { moduleRoles: roles, lockPollMs: 20 });
    await service().install(mod.manifest.id);
    const role = moduleRoleName(mod.manifest.schema);
    assert.equal((await pool!.query("select 1 from pg_roles where rolname = $1", [role])).rowCount, 1);
    assert.equal((await pool!.query("select 1 from core.module_roles where module_id = $1", [mod.manifest.id])).rowCount, 1);

    await service().uninstall(mod.manifest.id, "purge");

    assert.equal((await pool!.query("select 1 from pg_roles where rolname = $1", [role])).rowCount, 0);
    assert.equal((await pool!.query("select 1 from pg_namespace where nspname = $1", [mod.manifest.schema])).rowCount, 0);
    assert.equal((await pool!.query("select 1 from core.module_roles where module_id = $1", [mod.manifest.id])).rowCount, 0);
    assert.equal((await pool!.query("select 1 from core.module_jobs where module_id = $1", [mod.manifest.id])).rowCount, 0);

    await service().install(mod.manifest.id);
    assert.equal((await pool!.query(`select count(*)::int as n from "${mod.manifest.schema}".t`)).rows[0].n, 1);
  });

  test("uninstalling and keeping the data leaves the login, and re-enabling needs nothing new", async () => {
    const mod = box.add();
    mod.write("0001_t.sql", "create table t (n int)");
    const service = () => new LifecycleService(pool!, box.registry({ allowUnsupportedPlatform: true }), { moduleRoles: roles, lockPollMs: 20 });
    await service().install(mod.manifest.id);
    await service().uninstall(mod.manifest.id, "keep");
    assert.equal((await pool!.query("select 1 from pg_roles where rolname = $1", [moduleRoleName(mod.manifest.schema)])).rowCount, 1);
    assert.equal((await pool!.query("select 1 from pg_namespace where nspname = $1", [mod.manifest.schema])).rowCount, 1);
  });
});
