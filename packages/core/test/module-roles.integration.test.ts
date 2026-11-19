import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { ModuleRoleError, ModuleRoles, moduleRoleName } from "../src/data/module-roles.ts";
import { createPool } from "../src/pool.ts";
import { createScratchDatabase } from "../src/testing.ts";

const KEY = "k".repeat(40);
const OTHER_KEY = "o".repeat(40);

let pool: pg.Pool | undefined;
let url: string;
let skipReason: string | undefined;
let drop: (() => Promise<void>) | undefined;
const schemas: string[] = [];
const extraRoles: string[] = [];

const fresh = (masterKey = KEY, over: Partial<ConstructorParameters<typeof ModuleRoles>[0]> = {}) => new ModuleRoles({ pool: pool!, connectionString: url, masterKey, ...over });
const newSchema = () => {
  const schema = `m_${randomBytes(5).toString("hex")}`;
  schemas.push(schema);
  return schema;
};

before(async () => {
  const scratch = await createScratchDatabase();
  if (scratch.url === undefined) {
    skipReason = scratch.skipReason;
    return;
  }
  drop = scratch.drop;
  url = scratch.url;
  pool = createPool(url);
  await pool.query("create schema if not exists core");
  await pool.query("create table core.secret_stuff (n int)");
  await pool.query("insert into core.secret_stuff values (1)");
});

after(async () => {
  if (pool) {
    const roles = fresh();
    for (const schema of schemas) await roles.drop(schema);
    for (const role of extraRoles) {
      await pool.query(`drop owned by "${role}"`).catch(() => undefined);
      await pool.query(`drop role if exists "${role}"`);
    }
    await pool.end();
  }
  await drop?.();
});

const guard = (name: string, run: () => Promise<void>) =>
  it(name, async (t) => {
    if (!pool) return t.skip(skipReason);
    await run();
  });

describe("moduleRoleName", () => {
  it("is mnx_m_ plus the schema, and a digest when that would not fit in 63 characters", () => {
    assert.equal(moduleRoleName("contacts"), "mnx_m_contacts");
    const long = "a".repeat(63);
    const name = moduleRoleName(long);
    assert.ok(name.length <= 63);
    assert.match(name, /^mnx_m_[0-9a-f]+$/);
    assert.notEqual(name, moduleRoleName("a".repeat(62) + "b"));
    assert.equal(moduleRoleName(long), name, "the same schema always gives the same role");
  });
});

describe("ModuleRoles: a login role of its own for every module", () => {
  guard("creates a role that can log in with the derived password and has no power beyond that", async () => {
    const schema = newSchema();
    const roles = fresh();
    const role = await roles.ensure(schema);
    assert.equal(role, moduleRoleName(schema));
    const { rows } = await pool!.query("select rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls from pg_roles where rolname = $1", [role]);
    assert.deepEqual(rows, [{ rolcanlogin: true, rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolbypassrls: false }]);
    const modulePool = await roles.pool(schema);
    assert.equal((await modulePool.query("select current_user, session_user")).rows[0].session_user, role, "the session itself belongs to the module, so there is no other user to return to");
    await roles.close();
  });

  guard("cannot read or write the platform's tables, nor create anything outside its own schema", async () => {
    const schema = newSchema();
    const roles = fresh();
    const modulePool = await roles.pool(schema);
    await assert.rejects(modulePool.query("select * from core.secret_stuff"), /permission denied/);
    await assert.rejects(modulePool.query("insert into core.secret_stuff values (2)"), /permission denied/);
    await assert.rejects(modulePool.query("create table public.loose (n int)"), /permission denied/);
    await assert.rejects(modulePool.query("create table core.loose (n int)"), /permission denied/);
    await assert.rejects(modulePool.query("select set_config('role', 'none', true), query_to_xml('select * from core.secret_stuff', true, false, '')"), /permission denied/);
    await roles.close();
  });

  guard("makes the platform a member of the role, so it can still manage what the role owns", async () => {
    const schema = newSchema();
    const roles = fresh();
    const role = await roles.ensure(schema);
    const { rows } = await pool!.query("select pg_has_role(current_user, $1, 'member') as member", [role]);
    assert.equal(rows[0].member, true);
    await roles.close();
  });

  guard("is idempotent, and two processes asking at the same moment end up with one role that works", async () => {
    const schema = newSchema();
    const a = fresh();
    const b = fresh();
    await Promise.all([...Array.from({ length: 4 }, () => a.ensure(schema)), ...Array.from({ length: 4 }, () => b.ensure(schema))]);
    const { rows } = await pool!.query("select count(*)::int as n from pg_roles where rolname = $1", [moduleRoleName(schema)]);
    assert.equal(rows[0].n, 1);
    assert.equal((await (await a.pool(schema)).query("select 1 as ok")).rows[0].ok, 1);
    assert.equal((await (await b.pool(schema)).query("select 1 as ok")).rows[0].ok, 1);
    await Promise.all([a.close(), b.close()]);
  });

  guard("gives every module a different password, and follows the master key", async () => {
    const one = newSchema();
    const two = newSchema();
    const roles = fresh();
    await roles.ensure(one);
    await roles.ensure(two);
    const wrong = new pg.Pool({ connectionString: url.replace(/\/\/[^@]*@/, `//${moduleRoleName(one)}:wrong@`), max: 1 });
    await assert.rejects(wrong.query("select 1"), /password authentication failed|authentication/);
    await wrong.end();
    const swapped = new pg.Pool({ connectionString: url.replace(/\/\/[^@]*@/, `//${moduleRoleName(one)}:${encodeURIComponent("x")}@`), max: 1 });
    await assert.rejects(swapped.query("select 1"));
    await swapped.end();
    await roles.close();
    const other = fresh(OTHER_KEY);
    assert.equal((await (await other.pool(one)).query("select 1 as ok")).rows[0].ok, 1, "asking again with another key makes the role follow that key");
    await other.close();
    const back = fresh(KEY);
    assert.equal((await (await back.pool(one)).query("select 1 as ok")).rows[0].ok, 1);
    await back.close();
  });

  guard("keeps each module pool small and ends them all on close", async () => {
    const schema = newSchema();
    const roles = fresh(KEY, { maxConnections: 2 });
    const modulePool = await roles.pool(schema);
    assert.equal(modulePool, await roles.pool(schema), "one pool per module");
    assert.equal(modulePool.options.max, 2);
    await Promise.all(Array.from({ length: 6 }, () => modulePool.query("select pg_sleep(0.05)")));
    assert.ok(modulePool.totalCount <= 2);
    await roles.close();
    assert.equal(modulePool.ended, true);
    await assert.rejects(roles.pool(schema), /closed/);
  });

  guard("drops the role and what it owns, and a role that is not there is not an error", async () => {
    const schema = newSchema();
    const roles = fresh();
    const modulePool = await roles.pool(schema);
    await modulePool.end();
    await roles.close();
    const again = fresh();
    await again.drop(schema);
    await again.drop(schema);
    const { rows } = await pool!.query("select count(*)::int as n from pg_roles where rolname = $1", [moduleRoleName(schema)]);
    assert.equal(rows[0].n, 0);
  });

  guard("refuses with a clear message, and creates nothing, when the database user cannot create roles", async () => {
    const limited = `mnx_test_limited_${randomBytes(4).toString("hex")}`;
    extraRoles.push(limited);
    await pool!.query(`create role "${limited}" login password 'pw' nocreaterole nosuperuser`);
    const dbName = new URL(url).pathname.slice(1);
    await pool!.query(`grant connect on database "${dbName}" to "${limited}"`);
    const target = new URL(url);
    target.username = limited;
    target.password = "pw";
    const limitedPool = createPool(target.toString());
    const schema = newSchema();
    const roles = new ModuleRoles({ pool: limitedPool, connectionString: url, masterKey: KEY });
    await assert.rejects(roles.ensure(schema), (error: unknown) => {
      assert.ok(error instanceof ModuleRoleError);
      assert.equal(error.code, "cannot-create-role");
      assert.match(error.message, /CREATEROLE/);
      assert.doesNotMatch(error.message, new RegExp(KEY));
      return true;
    });
    const { rows } = await pool!.query("select count(*)::int as n from pg_roles where rolname = $1", [moduleRoleName(schema)]);
    assert.equal(rows[0].n, 0);
    await limitedPool.end();
  });
});
