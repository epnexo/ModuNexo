import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import { type Auth, createAuth } from "../src/auth/auth.ts";
import { AdminRefusedError } from "../src/auth/admin.ts";
import { createUser, listUsers, setUserRole } from "../src/auth/users.ts";
import { Registry } from "../src/registry.ts";
import { migrate } from "../src/runner.ts";
import { createScratchDatabase } from "../src/testing.ts";

const PASSWORD = "correct horse battery";
let pool: pg.Pool | undefined;
let auth: Auth;
let skipReason: string | undefined;
let drop: () => Promise<void> = async () => undefined;

before(async () => {
  const db = await createScratchDatabase();
  if (!db.url) {
    skipReason = db.skipReason;
    return;
  }
  const { createPool } = await import("../src/pool.ts");
  pool = createPool(db.url);
  drop = db.drop;
  const registry = new Registry();
  registry.registerCore();
  await migrate(pool, registry);
  auth = createAuth({ pool, masterKey: "k".repeat(32), baseURL: "http://localhost:3000", validateSchema: false });
});

after(async () => {
  await pool?.end();
  await drop();
});

const test = (name: string, run: () => Promise<void>) =>
  it(name, async (t) => {
    if (!pool) return t.skip(skipReason);
    await run();
  });

const roleOf = async (email: string) => (await pool!.query('select "role" from core.auth_user where "email" = $1', [email])).rows[0]?.role as string | undefined;

describe("users and roles", () => {
  test("creates an administrator and an operator, each with its role, and lists them with the role", async () => {
    await createUser(auth, { email: "Boss@Example.test", name: "Boss", password: PASSWORD, role: "admin" });
    await createUser(auth, { email: "ana@example.test", name: "Ana", password: PASSWORD, role: "operator" });
    assert.equal(await roleOf("boss@example.test"), "admin");
    assert.equal(await roleOf("ana@example.test"), "operator");
    assert.deepEqual(await listUsers(pool!), [
      { email: "ana@example.test", name: "Ana", role: "operator", banned: false },
      { email: "boss@example.test", name: "Boss", role: "admin", banned: false },
    ]);
  });

  test("an operator can sign in with the password it was given", async () => {
    const result = await auth.api.signInEmail({ body: { email: "ana@example.test", password: PASSWORD } });
    assert.equal(result.user.email, "ana@example.test");
  });

  test("refuses a role it does not know, and a duplicate email, and a short password, creating nobody", async () => {
    const before = (await listUsers(pool!)).length;
    await assert.rejects(createUser(auth, { email: "x@example.test", name: "X", password: PASSWORD, role: "root" as never }), AdminRefusedError);
    await assert.rejects(createUser(auth, { email: "ana@example.test", name: "Ana2", password: PASSWORD, role: "operator" }), /already exists/);
    await assert.rejects(createUser(auth, { email: "y@example.test", name: "Y", password: "short", role: "operator" }), /at least/);
    assert.equal((await listUsers(pool!)).length, before);
  });

  test("changes a role, reports when nothing changed, and refuses an unknown user or role", async () => {
    assert.deepEqual(await setUserRole(pool!, "ana@example.test", "admin"), { email: "ana@example.test", role: "admin", changed: true });
    assert.equal(await roleOf("ana@example.test"), "admin");
    assert.deepEqual(await setUserRole(pool!, "ana@example.test", "admin"), { email: "ana@example.test", role: "admin", changed: false });
    await assert.rejects(setUserRole(pool!, "nobody@example.test", "admin"), /no user/);
    await assert.rejects(setUserRole(pool!, "ana@example.test", "root" as never), AdminRefusedError);
    assert.equal(await roleOf("ana@example.test"), "admin");
  });

  test("never leaves the platform without an active administrator", async () => {
    await setUserRole(pool!, "ana@example.test", "operator");
    await assert.rejects(setUserRole(pool!, "boss@example.test", "operator"), /last administrator/);
    assert.equal(await roleOf("boss@example.test"), "admin");
    await pool!.query(`update core.auth_user set "banned" = true where "email" = 'boss@example.test'`);
    // A banned administrator does not count: promoting the operator first is the only way, and it must work.
    assert.equal((await setUserRole(pool!, "ana@example.test", "admin")).changed, true);
    await pool!.query(`update core.auth_user set "banned" = false where "email" = 'boss@example.test'`);
  });

  test("two concurrent demotions cannot both succeed when only two administrators exist", async () => {
    // boss and ana are administrators now.
    const results = await Promise.allSettled([setUserRole(pool!, "boss@example.test", "operator"), setUserRole(pool!, "ana@example.test", "operator")]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const admins = (await listUsers(pool!)).filter((u) => u.role === "admin" && !u.banned);
    assert.equal(admins.length, 1);
  });
});
