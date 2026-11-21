import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type TestContext, afterEach, beforeEach, describe, it } from "node:test";
import { Registry } from "../src/registry.ts";
import { createPool } from "../src/pool.ts";
import { migrate } from "../src/runner.ts";
import { createScratchDatabase } from "../src/testing.ts";

const execute = promisify(execFile);
const script = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

/** Run the script as `npm run db:migrate` does, with only the environment it is given. */
const run = (args: string[], env: Record<string, string>) =>
  execute(process.execPath, ["--import", "tsx", script, "db:migrate", ...args], { env: { PATH: process.env.PATH, MODUNEXO_MASTER_KEY: process.env.MODUNEXO_MASTER_KEY, ...env } });

let modulesDir: string;
beforeEach(() => {
  modulesDir = mkdtempSync(join(tmpdir(), "modunexo-cli-modules-"));
});
afterEach(() => rmSync(modulesDir, { recursive: true, force: true }));

function addModule(id: string, files: Record<string, string>) {
  mkdirSync(join(modulesDir, id, "migrations"), { recursive: true });
  const manifest = { id, version: "1.0.0", name: id, platform: "^0.1.0", dependsOn: {}, schema: id, migrationsDir: "migrations", nav: [] };
  writeFileSync(join(modulesDir, id, "manifest.ts"), `export default ${JSON.stringify(manifest)};\n`);
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(modulesDir, id, "migrations", name), sql);
}

/** Run `work` against a database of its own, so no other test or installed module can change the outcome. */
async function inScratchDatabase(t: TestContext, work: (url: string) => Promise<void>): Promise<void> {
  const scratch = await createScratchDatabase();
  if (!scratch.url) return t.skip(scratch.skipReason);
  try {
    await work(scratch.url);
  } finally {
    await scratch.drop();
  }
}

describe("db:migrate command", () => {
  it("fails with a clear message when DATABASE_URL is not set", async () => {
    await assert.rejects(run([], {}), (error: { stderr: string; code: number }) => error.code === 1 && /DATABASE_URL is not set/.test(error.stderr));
  });

  it("migrates the core only: a module that is on disk but not installed is left alone", async (t) => {
    addModule("alpha", { "0001_create.sql": "create table items (x int);" });
    await inScratchDatabase(t, async (url) => {
      const first = await run(["--modules-dir", modulesDir], { DATABASE_URL: url });
      assert.match(first.stdout, /applied core\/0001_init\.sql/);
      assert.doesNotMatch(first.stdout, /alpha/);

      const second = await run(["--modules-dir", modulesDir], { DATABASE_URL: url });
      assert.match(second.stdout, /nothing to apply/);
    });
  });

  it("migrates only the core when the modules directory is empty", async (t) => {
    await inScratchDatabase(t, async (url) => {
      const { stdout } = await run(["--modules-dir", modulesDir], { DATABASE_URL: url });
      assert.match(stdout, /applied core\/0001_init\.sql/);
      assert.doesNotMatch(stdout, /applied (?!core\/)/);
    });
  });

  it("prints a warning for a dangling symlink and still migrates the core", async (t) => {
    addModule("alpha", { "0001_create.sql": "create table items (x int);" });
    symlinkSync(join(modulesDir, "gone"), join(modulesDir, "dangling"), "dir");
    await inScratchDatabase(t, async (url) => {
      const { stdout, stderr } = await run(["--modules-dir", modulesDir], { DATABASE_URL: url });
      assert.match(stderr, /warning: "dangling" is a symlink whose target cannot be read/);
      assert.match(stdout, /applied core\/0001_init\.sql/);
    });
  });

  it("gives the installed modules their own login and their declarations, and leaves a second run unchanged", async (t) => {
    // A module installed by the version before logins existed: its schema belongs to the platform user.
    addModule("alpha", { "0001_create.sql": "create table items (x int); insert into items values (7);" });
    await inScratchDatabase(t, async (url) => {
      await run(["--modules-dir", modulesDir], { DATABASE_URL: url });
      const pool = createPool(url);
      try {
        const registry = new Registry({ allowUnsupportedPlatform: true });
        registry.registerCore();
        const manifest = (await import(join(modulesDir, "alpha", "manifest.ts"))).default;
        registry.register({ ...manifest, migrationsDir: join(modulesDir, "alpha", "migrations") });
        await migrate(pool, registry);
        await pool.query("insert into core.modules (id, state, installed_version) values ('alpha', 'enabled', '1.0.0')");
        const owner = async () => (await pool.query("select pg_get_userbyid(nspowner) as o from pg_namespace where nspname = 'alpha'")).rows[0].o as string;
        assert.notEqual(await owner(), "mnx_m_alpha", "owned by the platform before");
        assert.equal((await pool.query("select 1 from core.module_roles")).rowCount, 0);

        const first = await run(["--modules-dir", modulesDir], { DATABASE_URL: url });
        assert.match(first.stdout, /module logins and declarations are up to date for 1 installed module/);
        assert.equal(await owner(), "mnx_m_alpha");
        assert.equal((await pool.query("select 1 from core.module_roles where module_id = 'alpha'")).rowCount, 1);
        assert.deepEqual((await pool.query("select x from alpha.items")).rows, [{ x: 7 }], "the data stays");

        await run(["--modules-dir", modulesDir], { DATABASE_URL: url });
        assert.equal(await owner(), "mnx_m_alpha");
      } finally {
        await pool.end();
      }
    });
  });

  it("does not ask for the master key when no module is installed", async (t) => {
    await inScratchDatabase(t, async (url) => {
      const { stdout } = await run(["--modules-dir", modulesDir], { DATABASE_URL: url, MODUNEXO_MASTER_KEY: "" });
      assert.match(stdout, /applied core\/0001_init\.sql/);
    });
  });

  it("fails with a non-zero exit when --modules-dir points at a path that does not exist", async () => {
    const missing = join(modulesDir, "nope");
    await assert.rejects(run(["--modules-dir", missing], { DATABASE_URL: "postgres://u:p@127.0.0.1:1/x_test" }), (error: { stderr: string; code: number }) => {
      assert.equal(error.code, 2, "a wrong argument is a usage error");
      assert.match(error.stderr, /modules directory ".*nope" does not exist/);
      return true;
    });
  });

  it("rejects an option it does not know", async () => {
    await assert.rejects(run(["--bogus"], { DATABASE_URL: "postgres://u:p@127.0.0.1:1/x_test" }), (error: { stderr: string; code: number }) => {
      return error.code === 2 && /--bogus/.test(error.stderr);
    });
  });
});
