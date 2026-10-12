import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { type TestContext, describe, it } from "node:test";
import type pg from "pg";
import { createPool } from "../src/pool.ts";
import { createScratchDatabase } from "../src/testing.ts";

const script = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
const MASTER_KEY = "m".repeat(40);

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

async function inScratchDatabase(t: TestContext, work: (db: pg.Pool, cli: Cli) => Promise<void>, migrated = true): Promise<void> {
  const scratch = await createScratchDatabase();
  if (!scratch.url) return t.skip(scratch.skipReason);
  const db = createPool(scratch.url);
  // The auth commands must work without the master key, so it is given only to the commands that need it.
  const cli: Cli = (args, stdin) => spawn(args, { DATABASE_URL: scratch.url!, ...(args[0] === "admin" ? { EPNEXO_MASTER_KEY: MASTER_KEY } : {}) }, stdin);
  try {
    if (migrated) assert.equal((await cli(["db:migrate"])).code, 0);
    await work(db, cli);
  } finally {
    await db.end();
    await scratch.drop();
  }
}

describe("cli: auth", () => {
  it("reports that sign-in is required by default, without the master key", async (t) => {
    await inScratchDatabase(t, async (_db, cli) => {
      const result = await cli(["auth", "status"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout.trim(), "sign-in: required");
    });
  });

  it("disables sign-in, says what that means, and status reports it", async (t) => {
    await inScratchDatabase(t, async (db, cli) => {
      const result = await cli(["auth", "disable"]);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /^sign-in is now disabled/m);
      assert.match(result.stdout, /local network/);
      assert.match(result.stdout, /installing modules/);
      assert.match(result.stdout, /auth require/);
      assert.equal((await cli(["auth", "status"])).stdout.trim(), "sign-in: disabled");
      const { rows } = await db.query("select value, updated_by from core.platform_settings where key = 'auth.signIn'");
      assert.deepEqual(rows, [{ value: "disabled", updated_by: "cli" }]);
    });
  });

  it("refuses to require sign-in while no administrator exists, with exit code 3, and keeps it disabled", async (t) => {
    await inScratchDatabase(t, async (_db, cli) => {
      await cli(["auth", "disable"]);
      const result = await cli(["auth", "require"]);
      assert.equal(result.code, 3);
      assert.match(result.stderr, /^refused: .*no administrator/);
      assert.match(result.stderr, /admin create/);
      assert.equal((await cli(["auth", "status"])).stdout.trim(), "sign-in: disabled");
    });
  });

  it("requires sign-in again once an administrator exists", async (t) => {
    await inScratchDatabase(t, async (_db, cli) => {
      await cli(["auth", "disable"]);
      assert.equal((await cli(["admin", "create", "--email", "ada@example.test", "--name", "Ada"], "correct horse battery\n")).code, 0);
      const result = await cli(["auth", "require"]);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /^sign-in is now required/m);
      assert.equal((await cli(["auth", "status"])).stdout.trim(), "sign-in: required");
    });
  });

  it("is idempotent: repeating a command says so, succeeds and writes nothing", async (t) => {
    await inScratchDatabase(t, async (db, cli) => {
      await cli(["auth", "disable"]);
      const stamp = async () => (await db.query("select updated_at from core.platform_settings where key = 'auth.signIn'")).rows[0].updated_at.getTime();
      const first = await stamp();
      const again = await cli(["auth", "disable"]);
      assert.equal(again.code, 0);
      assert.match(again.stdout, /already disabled/);
      assert.equal(await stamp(), first);

      assert.equal((await cli(["admin", "create", "--email", "ada@example.test", "--name", "Ada"], "correct horse battery\n")).code, 0);
      assert.equal((await cli(["auth", "require"])).code, 0);
      const repeated = await cli(["auth", "require"]);
      assert.equal(repeated.code, 0);
      assert.match(repeated.stdout, /already required/);
    });
  });

  it("is a usage error without a subcommand, with an unknown one, or with extra arguments", async (t) => {
    await inScratchDatabase(t, async (_db, cli) => {
      for (const args of [["auth"], ["auth", "off"], ["auth", "disable", "now"], ["auth", "status", "--json"]]) {
        assert.equal((await cli(args)).code, 2, args.join(" "));
      }
    });
  });

  it("fails with exit code 1 and points at db:migrate when the database was never migrated", async (t) => {
    await inScratchDatabase(
      t,
      async (_db, cli) => {
        const result = await cli(["auth", "status"]);
        assert.equal(result.code, 1);
        assert.match(result.stderr, /npm run db:migrate/);
      },
      false,
    );
  });

  it("is listed in --help", async () => {
    const result = await spawn(["--help"], {});
    assert.match(result.stdout, /auth status/);
    assert.match(result.stdout, /auth require/);
    assert.match(result.stdout, /auth disable/);
  });
});
