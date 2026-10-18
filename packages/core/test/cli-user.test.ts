import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { type TestContext, describe, it } from "node:test";
import type pg from "pg";
import { createPool } from "../src/pool.ts";
import { createScratchDatabase } from "../src/testing.ts";

const script = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
const MASTER_KEY = "m".repeat(40);
const PASSWORD = "correct horse battery";

interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
}

const spawn = (args: string[], env: Record<string, string>, stdin = ""): Promise<Outcome> =>
  new Promise((resolve) => {
    const child = execFile(process.execPath, ["--import", "tsx", script, ...args], { env: { PATH: process.env.PATH, ...env } }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : ((error as { code?: number }).code ?? 1), stdout, stderr });
    });
    child.stdin?.end(stdin);
  });

type Cli = (args: string[], stdin?: string) => Promise<Outcome>;

async function inScratchDatabase(t: TestContext, work: (db: pg.Pool, cli: Cli) => Promise<void>): Promise<void> {
  const scratch = await createScratchDatabase();
  if (!scratch.url) return t.skip(scratch.skipReason);
  const db = createPool(scratch.url);
  const cli: Cli = (args, stdin) => spawn(args, { DATABASE_URL: scratch.url!, EPNEXO_MASTER_KEY: MASTER_KEY }, stdin);
  try {
    assert.equal((await cli(["db:migrate"])).code, 0);
    await work(db, cli);
  } finally {
    await db.end();
    await scratch.drop();
  }
}

const users = async (db: pg.Pool) => (await db.query('select "email", "role" from core.auth_user order by "email"')).rows;
const create = (email: string, role: string) => ["user", "create", "--email", email, "--name", email.split("@")[0]!, "--role", role];

describe("cli: user", () => {
  it("creates users with a role from a password on standard input, and lists them", async (t) => {
    await inScratchDatabase(t, async (db, cli) => {
      const admin = await cli(create("ada@example.test", "admin"), PASSWORD);
      assert.equal(admin.code, 0, admin.stderr);
      assert.equal(admin.stdout.trim(), 'created admin "ada@example.test"');
      const operator = await cli(create("bo@example.test", "operator"), PASSWORD);
      assert.equal(operator.stdout.trim(), 'created operator "bo@example.test"');
      assert.ok(!`${admin.stdout}${admin.stderr}${operator.stdout}${operator.stderr}`.includes(PASSWORD));
      assert.deepEqual(await users(db), [
        { email: "ada@example.test", role: "admin" },
        { email: "bo@example.test", role: "operator" },
      ]);

      const listed = await cli(["user", "list"]);
      assert.equal(listed.code, 0, listed.stderr);
      assert.match(listed.stdout, /ada@example\.test\s+admin/);
      assert.match(listed.stdout, /bo@example\.test\s+operator/);
      const json = JSON.parse((await cli(["user", "list", "--json"])).stdout) as Array<{ email: string; role: string }>;
      assert.deepEqual(json.map((u) => `${u.email}:${u.role}`), ["ada@example.test:admin", "bo@example.test:operator"]);
    });
  });

  it("changes a role, and refuses with exit code 3 to demote the last administrator", async (t) => {
    await inScratchDatabase(t, async (db, cli) => {
      await cli(create("ada@example.test", "admin"), PASSWORD);
      await cli(create("bo@example.test", "operator"), PASSWORD);
      const refused = await cli(["user", "role", "--email", "ada@example.test", "--role", "operator"]);
      assert.equal(refused.code, 3);
      assert.match(refused.stderr, /^refused: .*last administrator/);
      const promoted = await cli(["user", "role", "--email", "BO@example.test", "--role", "admin"]);
      assert.equal(promoted.code, 0, promoted.stderr);
      assert.equal(promoted.stdout.trim(), '"bo@example.test" is now admin');
      assert.equal((await cli(["user", "role", "--email", "ada@example.test", "--role", "operator"])).code, 0);
      assert.deepEqual(await users(db), [
        { email: "ada@example.test", role: "operator" },
        { email: "bo@example.test", role: "admin" },
      ]);
      const same = await cli(["user", "role", "--email", "bo@example.test", "--role", "admin"]);
      assert.equal(same.stdout.trim(), '"bo@example.test" already is admin');
    });
  });

  it("is a usage error with an unknown role, a missing option, a password argument or an unknown command, creating nobody", async (t) => {
    await inScratchDatabase(t, async (db, cli) => {
      for (const args of [
        create("x@example.test", "root"),
        ["user", "create", "--email", "x@example.test", "--name", "X"],
        ["user", "create", "--name", "X", "--role", "operator"],
        [...create("x@example.test", "operator"), PASSWORD],
        ["user", "role", "--email", "x@example.test"],
        ["user"],
        ["user", "remove"],
        ["user", "list", "--role", "admin"],
      ]) {
        assert.equal((await cli(args, PASSWORD)).code, 2, args.join(" "));
      }
      assert.deepEqual(await users(db), []);
    });
  });

  it("admin create still makes an administrator", async (t) => {
    await inScratchDatabase(t, async (db, cli) => {
      assert.equal((await cli(["admin", "create", "--email", "ada@example.test", "--name", "Ada"], PASSWORD)).code, 0);
      assert.deepEqual(await users(db), [{ email: "ada@example.test", role: "admin" }]);
    });
  });

  it("is listed in --help", async () => {
    const result = await spawn(["--help"], {});
    assert.match(result.stdout, /user create --email <email> --name <name> --role admin\|operator/);
    assert.match(result.stdout, /user role --email <email> --role admin\|operator/);
    assert.match(result.stdout, /user list/);
  });
});
