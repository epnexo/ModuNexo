import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type TestContext, afterEach, beforeEach, describe, it } from "node:test";
import type pg from "pg";
import { createPool } from "../src/pool.ts";
import { createScratchDatabase } from "../src/testing.ts";

const script = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
}

const run = (args: string[], env: Record<string, string>): Promise<Outcome> =>
  new Promise((resolve) => {
    const child = execFile(process.execPath, ["--import", "tsx", script, ...args], { env: { PATH: process.env.PATH, ...env } }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : ((error as { code?: number }).code ?? 1), stdout, stderr });
    });
    child.stdin?.end("");
  });

const OLD = "11111111-1111-4111-8111-111111111111";
const NEW = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";

let modulesDir: string;
let dataDir: string;
beforeEach(() => {
  modulesDir = mkdtempSync(join(tmpdir(), "modunexo-cli-files-"));
  dataDir = mkdtempSync(join(tmpdir(), "modunexo-cli-files-data-"));
  for (const id of ["alpha", "beta"]) {
    mkdirSync(join(modulesDir, id, "migrations"), { recursive: true });
    const manifest = { id, version: "1.0.0", name: id, platform: "^0.1.0", dependsOn: {}, schema: id, migrationsDir: "migrations", nav: [], files: {} };
    writeFileSync(join(modulesDir, id, "manifest.ts"), `export default ${JSON.stringify(manifest)};\n`);
    writeFileSync(join(modulesDir, id, "package.json"), JSON.stringify({ name: `@fixture/${id}`, private: true }));
    writeFileSync(join(modulesDir, id, "migrations", "0001_init.sql"), "create table t (id int);");
  }
});
afterEach(() => {
  rmSync(modulesDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

type Cli = (args: string[]) => Promise<Outcome>;

async function inScratchDatabase(t: TestContext, work: (db: pg.Pool, cli: Cli) => Promise<void>): Promise<void> {
  const scratch = await createScratchDatabase();
  if (!scratch.url) return t.skip(scratch.skipReason);
  const url = scratch.url;
  const db = createPool(url);
  const cli: Cli = (args) => run([...args, "--modules-dir", modulesDir], { DATABASE_URL: url, MODUNEXO_DATA_DIR: dataDir });
  try {
    assert.equal((await cli(["db:migrate"])).code, 0);
    assert.equal((await cli(["modules", "install", "alpha"])).code, 0);
    await work(db, cli);
  } finally {
    await db.end();
    await scratch.drop();
  }
}

/** A row and its bytes, made the way the service makes them. */
async function seed(db: pg.Pool, moduleId: string, id: string, name: string, at: string, ref: string | null = null): Promise<void> {
  mkdirSync(join(dataDir, "files", moduleId, id.slice(0, 2)), { recursive: true });
  writeFileSync(join(dataDir, "files", moduleId, id.slice(0, 2), id), "stored bytes");
  await db.query("insert into core.files (id, module_id, name, content_type, size, sha256, ref, created_at) values ($1, $2, $3, 'text/plain', 12, $4, $5, $6)", [id, moduleId, name, "a".repeat(64), ref, at]);
}
const bytesOf = (moduleId: string, id: string) => join(dataDir, "files", moduleId, id.slice(0, 2), id);

describe("cli: files list and delete", () => {
  it("lists the files newest first without their content, and as JSON with the details", async (t) => {
    await inScratchDatabase(t, async (db, cli) => {
      await seed(db, "alpha", OLD, "old.txt", "2026-10-01T10:00:00Z", "message:1");
      await seed(db, "alpha", NEW, "new.txt", "2026-10-02T10:00:00Z");
      await seed(db, "beta", OTHER, "other.txt", "2026-10-03T10:00:00Z");
      const list = await cli(["files", "list"]);
      assert.equal(list.code, 0, list.stderr);
      assert.match(list.stdout, /ID\s+MODULE\s+NAME\s+TYPE\s+SIZE\s+CREATED/);
      const lines = list.stdout.trim().split("\n").slice(1);
      assert.deepEqual(lines.map((line) => line.split(/\s+/)[1]), ["beta", "alpha", "alpha"]);
      assert.match(lines[1]!, new RegExp(`${NEW}\\s+alpha\\s+new\\.txt\\s+text/plain\\s+12\\s+2026-10-02 10:00:00`));

      const alpha = JSON.parse((await cli(["files", "list", "alpha", "--json"])).stdout);
      assert.deepEqual(alpha.map((f: { id: string }) => f.id), [NEW, OLD]);
      assert.equal(alpha[1].ref, "message:1");
      assert.equal(alpha[1].sha256, "a".repeat(64));
      assert.equal(alpha[1].moduleId, "alpha");
      assert.equal(JSON.parse((await cli(["files", "list", "--limit", "1", "--json"])).stdout).length, 1);
    });
  });

  it("says so when there are no files", async (t) => {
    await inScratchDatabase(t, async (_db, cli) => {
      assert.equal((await cli(["files", "list"])).stdout.trim(), "no files");
      assert.equal((await cli(["files", "list", "beta"])).stdout.trim(), "no files");
    });
  });

  it("deletes a file's row and bytes, and only that file's", async (t) => {
    await inScratchDatabase(t, async (db, cli) => {
      await seed(db, "alpha", OLD, "old.txt", "2026-10-01T10:00:00Z");
      await seed(db, "alpha", NEW, "new.txt", "2026-10-02T10:00:00Z");
      const done = await cli(["files", "delete", "alpha", OLD]);
      assert.equal(done.code, 0, done.stderr);
      assert.equal(done.stdout.trim(), `deleted file ${OLD} (alpha old.txt)`);
      assert.equal(existsSync(bytesOf("alpha", OLD)), false);
      assert.equal(existsSync(bytesOf("alpha", NEW)), true);
      assert.deepEqual((await db.query("select id from core.files")).rows.map((r) => r.id), [NEW]);
    });
  });

  it("refuses, with exit code 3, a file the module does not have, and deletes nothing", async (t) => {
    await inScratchDatabase(t, async (db, cli) => {
      await seed(db, "alpha", OLD, "old.txt", "2026-10-01T10:00:00Z");
      const missing = await cli(["files", "delete", "alpha", NEW]);
      assert.equal(missing.code, 3);
      assert.match(missing.stderr, new RegExp(`^refused: module "alpha" has no file "${NEW}"`));
      const foreign = await cli(["files", "delete", "beta", OLD]);
      assert.equal(foreign.code, 3);
      assert.equal(existsSync(bytesOf("alpha", OLD)), true);
      assert.equal((await db.query("select 1 from core.files")).rowCount, 1);
    });
  });

  it("answers a usage error, exit code 2, for missing arguments and bad options", async (t) => {
    await inScratchDatabase(t, async (db, cli) => {
      await seed(db, "alpha", OLD, "old.txt", "2026-10-01T10:00:00Z");
      for (const [args, expected] of [
        [["files"], /no files command/],
        [["files", "wipe"], /unknown files command "wipe"/],
        [["files", "delete", "alpha"], /files delete takes a module id and a file id/],
        [["files", "delete", "alpha", OLD, "extra"], /files delete takes a module id and a file id/],
        [["files", "delete", "alpha", "not-a-uuid"], /files delete takes a module id and a file id \(a UUID\)/],
        [["files", "delete", "alpha", OLD, "--json"], /option --json does not apply to files delete/],
        [["files", "list", "a", "b"], /files list takes at most one module id/],
        [["files", "list", "--limit", "0"], /--limit takes a whole number from 1 to 500/],
        [["files", "list", "--limit", "501"], /--limit takes a whole number from 1 to 500/],
        [["files", "list", "--type", "x"], /option --type does not apply to files list/],
      ] as Array<[string[], RegExp]>) {
        const outcome = await cli(args);
        assert.equal(outcome.code, 2, args.join(" "));
        assert.match(outcome.stderr, expected, args.join(" "));
      }
      assert.equal(existsSync(bytesOf("alpha", OLD)), true, "nothing was deleted");
    });
  });
});
