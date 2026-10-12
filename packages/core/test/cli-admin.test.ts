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

/** Spawn the real script with only the environment it is given, feeding `stdin`; never rejects. */
const spawn = (args: string[], env: Record<string, string>, stdin = ""): Promise<Outcome> =>
  new Promise((resolve) => {
    const child = execFile(process.execPath, ["--import", "tsx", script, ...args], { env: { PATH: process.env.PATH, ...env } }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : ((error as { code?: number }).code ?? 1), stdout, stderr });
    });
    child.stdin?.end(stdin);
  });

type Cli = (args: string[], options?: { stdin?: string; env?: Record<string, string> }) => Promise<Outcome>;

async function inScratchDatabase(t: TestContext, work: (db: pg.Pool, cli: Cli, url: string) => Promise<void>, migrated = true): Promise<void> {
  const scratch = await createScratchDatabase();
  if (!scratch.url) return t.skip(scratch.skipReason);
  const url = scratch.url;
  const db = createPool(url);
  const cli: Cli = (args, options = {}) => spawn(args, options.env ?? { DATABASE_URL: url, EPNEXO_MASTER_KEY: MASTER_KEY }, options.stdin);
  try {
    if (migrated) assert.equal((await cli(["db:migrate"])).code, 0);
    await work(db, cli, url);
  } finally {
    await db.end();
    await scratch.drop();
  }
}

const users = async (db: pg.Pool) => (await db.query('select "email", "name", "role" from core.auth_user order by "email"')).rows;
const CREATE = ["admin", "create", "--email", "ada@example.test", "--name", "Ada Admin"];

describe("cli: admin create", () => {
  it("creates an administrator from a password on standard input and never prints the password", async (t) => {
    await inScratchDatabase(t, async (db, cli) => {
      const result = await cli(CREATE, { stdin: `${PASSWORD}\n` });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout.trim(), 'created administrator "ada@example.test"');
      assert.ok(!`${result.stdout}${result.stderr}`.includes(PASSWORD));
      assert.deepEqual(await users(db), [{ email: "ada@example.test", name: "Ada Admin", role: "admin" }]);
    });
  });

  it("keeps spaces inside the password and drops only the line ending", async (t) => {
    await inScratchDatabase(t, async (db, cli) => {
      assert.equal((await cli(CREATE, { stdin: "  spaced out password  \r\n" })).code, 0);
      const { rows } = await db.query('select "password" from core.auth_account');
      assert.equal(rows.length, 1);
      // Twelve characters counting its two spaces; trimming would leave ten and the length rule would refuse it.
      const second = await cli(["admin", "create", "--email", "bo@example.test", "--name", "Bo"], { stdin: " tencharact \n" });
      assert.equal(second.code, 0, second.stderr);
    });
  });

  it("refuses an email that already exists with exit code 3 and changes nothing", async (t) => {
    await inScratchDatabase(t, async (db, cli) => {
      assert.equal((await cli(CREATE, { stdin: PASSWORD })).code, 0);
      const again = await cli(["admin", "create", "--email", "ADA@example.test", "--name", "Impostor"], { stdin: "another long password" });
      assert.equal(again.code, 3);
      assert.match(again.stderr, /^refused: a user with the email "ada@example\.test" already exists/);
      assert.deepEqual(await users(db), [{ email: "ada@example.test", name: "Ada Admin", role: "admin" }]);
    });
  });

  it("refuses a password shorter than 12 characters, and an empty one, with exit code 3", async (t) => {
    await inScratchDatabase(t, async (db, cli) => {
      for (const stdin of ["elevenchars\n", ""]) {
        const result = await cli(CREATE, { stdin });
        assert.equal(result.code, 3);
        assert.match(result.stderr, /refused: the password must be at least 12 characters/);
        assert.ok(!result.stderr.includes("Better Auth"), `no library noise on a refusal: ${result.stderr}`);
      }
      assert.deepEqual(await users(db), []);
    });
  });

  it("is a usage error without --email or --name, or with the password as an argument", async (t) => {
    await inScratchDatabase(t, async (db, cli) => {
      for (const args of [
        ["admin", "create", "--name", "Ada"],
        ["admin", "create", "--email", "ada@example.test"],
        [...CREATE, PASSWORD],
        ["admin"],
        ["admin", "remove"],
      ]) {
        const result = await cli(args, { stdin: PASSWORD });
        assert.equal(result.code, 2, args.join(" "));
      }
      assert.deepEqual(await users(db), []);
    });
  });

  it("fails with exit code 1, naming the variable, when the master key is missing or short", async (t) => {
    await inScratchDatabase(t, async (db, cli, url) => {
      const environments: Record<string, string>[] = [{ DATABASE_URL: url }, { DATABASE_URL: url, EPNEXO_MASTER_KEY: "too-short" }];
      for (const env of environments) {
        const result = await cli(CREATE, { stdin: PASSWORD, env });
        assert.equal(result.code, 1);
        assert.match(result.stderr, /EPNEXO_MASTER_KEY/);
        assert.ok(!result.stderr.includes("too-short"));
      }
      assert.deepEqual(await users(db), []);
    });
  });

  it("fails with exit code 1 and points at db:migrate when the database was never migrated", async (t) => {
    await inScratchDatabase(
      t,
      async (_db, cli) => {
        const result = await cli(CREATE, { stdin: PASSWORD });
        assert.equal(result.code, 1);
        assert.match(result.stderr, /npm run db:migrate/);
      },
      false,
    );
  });

  it("is listed in --help", async () => {
    const result = await spawn(["--help"], {});
    assert.equal(result.code, 0);
    assert.match(result.stdout, /admin create --email <email> --name <name>/);
    assert.match(result.stdout, /EPNEXO_MASTER_KEY/);
  });
});
