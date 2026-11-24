import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createPool } from "../src/pool.ts";
import { createScratchDatabase } from "../src/testing.ts";
import { expectOk } from "./helpers/expect-ok.ts";

const script = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
}

const run = (args: string[], env: Record<string, string>): Promise<Outcome> =>
  new Promise((resolve) => {
    const child = execFile(process.execPath, ["--import", "tsx", script, ...args], { env: { PATH: process.env.PATH, MODUNEXO_MASTER_KEY: process.env.MODUNEXO_MASTER_KEY, ...env } }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : ((error as { code?: number }).code ?? 1), stdout, stderr });
    });
    child.stdin?.end("");
  });

let modulesDir: string;
beforeEach(() => {
  modulesDir = mkdtempSync(join(tmpdir(), "modunexo-cli-actions-"));
  mkdirSync(join(modulesDir, "alpha", "migrations"), { recursive: true });
  mkdirSync(join(modulesDir, "alpha", "jobs"), { recursive: true });
  const manifest = {
    id: "alpha",
    version: "1.0.0",
    name: "Alpha",
    platform: "^0.1.5",
    dependsOn: {},
    schema: "alpha",
    migrationsDir: "migrations",
    nav: [],
    permissions: [{ key: "alpha.write", label: "Write" }],
    jobs: [{ name: "touch", entry: "./jobs/touch.ts" }],
    actions: [{ key: "touch_it", label: "Touch it", description: "Touches one thing.", risk: "write", permission: "alpha.write", input: { n: { type: "int", min: 1, max: 9, required: true } }, job: "touch" }],
  };
  writeFileSync(join(modulesDir, "alpha", "manifest.ts"), `export default ${JSON.stringify(manifest)};\n`);
  writeFileSync(join(modulesDir, "alpha", "package.json"), JSON.stringify({ name: "@fixture/alpha", private: true }));
  writeFileSync(join(modulesDir, "alpha", "migrations", "0001_init.sql"), "create table t (id int);");
  writeFileSync(join(modulesDir, "alpha", "jobs", "touch.ts"), "export default async function () {}\n");
});
afterEach(() => rmSync(modulesDir, { recursive: true, force: true }));

describe("cli: actions, through the real command line", () => {
  it("lists what a module offers, takes an agent's proposal and shows it waiting", async (t) => {
    const scratch = await createScratchDatabase();
    if (!scratch.url) return t.skip(scratch.skipReason);
    const db = createPool(scratch.url);
    const cli = (args: string[]) => run([...args, "--modules-dir", modulesDir], { DATABASE_URL: scratch.url! });
    try {
      await expectOk(cli, ["db:migrate"]);
      await expectOk(cli, ["modules", "install", "alpha"]);

      const listed = await cli(["actions", "list"]);
      assert.equal(listed.code, 0, listed.stderr);
      assert.match(listed.stdout, /alpha\.touch_it/);
      assert.doesNotMatch(listed.stdout, /STATE\s+PACKAGE/, "it is not the list of modules");

      const proposed = await cli(["actions", "propose", "alpha.touch_it", "--input", '{"n":3}', "--via", "mcp", "--actor", "mcp:laptop"]);
      assert.equal(proposed.code, 0, proposed.stderr);
      const waiting = await cli(["actions", "proposals", "--status", "pending"]);
      assert.match(waiting.stdout, /alpha\.touch_it/);
      assert.equal((await db.query("select count(*)::int as n from core.action_proposals where status = 'pending'")).rows[0].n, 1);
    } finally {
      await db.end();
      await scratch.drop();
    }
  });
});
