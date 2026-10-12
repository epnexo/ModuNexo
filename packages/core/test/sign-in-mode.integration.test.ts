import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import { ModeRefusedError, readSignInMode, setSignInMode } from "../src/auth/mode.ts";
import { Registry } from "../src/registry.ts";
import { migrate } from "../src/runner.ts";
import { createScratchDatabase } from "../src/testing.ts";
import { createPool } from "../src/pool.ts";

let db: pg.Pool | undefined;
let skipReason: string | undefined;
let drop: (() => Promise<void>) | undefined;

before(async () => {
  const scratch = await createScratchDatabase();
  if (!scratch.url) {
    skipReason = scratch.skipReason;
    return;
  }
  db = createPool(scratch.url);
  drop = scratch.drop;
  const registry = new Registry();
  registry.registerCore();
  await migrate(db, registry);
});

after(async () => {
  await db?.end();
  await drop?.();
});

const test = (name: string, run: () => Promise<void>) =>
  it(name, async (t) => {
    if (!db) return t.skip(skipReason);
    await db.query("delete from core.platform_settings");
    await db.query("delete from core.auth_user");
    await run();
  });

const addUser = async (role: string | null, banned = false) => {
  const id = randomBytes(6).toString("hex");
  await db!.query(
    'insert into core.auth_user ("id", "name", "email", "emailVerified", "role", "banned") values ($1, $2, $3, false, $4, $5)',
    [id, "User", `${id}@example.test`, role, banned],
  );
};

describe("sign-in mode", () => {
  test("is required when nothing was ever set", async () => {
    assert.equal(await readSignInMode(db!), "required");
  });

  test("disabling persists, records who did it, and is read back", async () => {
    await setSignInMode(db!, "disabled", "cli");
    assert.equal(await readSignInMode(db!), "disabled");
    const { rows } = await db!.query("select key, value, updated_by from core.platform_settings");
    assert.deepEqual(rows, [{ key: "auth.signIn", value: "disabled", updated_by: "cli" }]);
  });

  test("disabling needs no administrator", async () => {
    assert.deepEqual(await setSignInMode(db!, "disabled", "cli"), { mode: "disabled", changed: true });
  });

  test("requiring is refused while no administrator exists, and the mode stays as it was", async () => {
    await setSignInMode(db!, "disabled", "cli");
    await addUser("user");
    await assert.rejects(setSignInMode(db!, "required", "cli"), (error: unknown) => error instanceof ModeRefusedError && /no administrator/.test(error.message));
    assert.equal(await readSignInMode(db!), "disabled");
  });

  test("a banned administrator does not count", async () => {
    await setSignInMode(db!, "disabled", "cli");
    await addUser("admin", true);
    await assert.rejects(setSignInMode(db!, "required", "cli"), ModeRefusedError);
    assert.equal(await readSignInMode(db!), "disabled");
  });

  test("requiring works once an active administrator exists", async () => {
    await setSignInMode(db!, "disabled", "cli");
    await addUser("admin");
    assert.deepEqual(await setSignInMode(db!, "required", "cli"), { mode: "required", changed: true });
    assert.equal(await readSignInMode(db!), "required");
  });

  test("setting the mode it already has reports no change", async () => {
    await setSignInMode(db!, "disabled", "cli");
    assert.deepEqual(await setSignInMode(db!, "disabled", "cli"), { mode: "disabled", changed: false });
    await addUser("admin");
    assert.deepEqual(await setSignInMode(db!, "required", "cli"), { mode: "required", changed: true });
    assert.deepEqual(await setSignInMode(db!, "required", "cli"), { mode: "required", changed: false });
  });

  test("any stored value other than disabled means required: the mode fails closed", async () => {
    for (const value of ['"off"', '"DISABLED"', "true", "false", "null", "0", '{"mode":"disabled"}', '""']) {
      await db!.query("delete from core.platform_settings");
      await db!.query("insert into core.platform_settings (key, value, updated_by) values ('auth.signIn', $1::jsonb, 'test')", [value]);
      assert.equal(await readSignInMode(db!), "required", value);
    }
  });

  test("a database error is not turned into a mode", async () => {
    const broken = createPool("postgres://epnexo:epnexo@127.0.0.1:1/none", { connectionTimeoutMillis: 500 });
    try {
      await assert.rejects(readSignInMode(broken));
    } finally {
      await broken.end();
    }
  });
});
