import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type TestContext, afterEach, beforeEach, describe, it } from "node:test";
import type pg from "pg";
import { createPool } from "../src/pool.ts";
import { Registry } from "../src/registry.ts";
import { SettingsService } from "../src/settings/service.ts";
import { createScratchDatabase } from "../src/testing.ts";

const script = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
const MASTER_KEY = "q".repeat(40);
const API_KEY = "sk-cli-secret-0123456789";

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

const manifestOf = (id: string) => ({
  id,
  version: "1.0.0",
  name: id,
  platform: "^0.1.0",
  dependsOn: {},
  schema: id,
  migrationsDir: "migrations",
  nav: [],
  ...(id === "alpha"
    ? {
        settings: [
          { key: "llm.url", label: "Endpoint", type: "string" },
          { key: "llm.key", label: "API key", type: "secret" },
          { key: "llm.model", label: "Model", type: "string" },
        ],
        llm: { baseUrlSetting: "llm.url", apiKeySetting: "llm.key", modelSetting: "llm.model" },
      }
    : {}),
});

let modulesDir: string;
beforeEach(() => {
  modulesDir = mkdtempSync(join(tmpdir(), "modunexo-cli-llm-"));
  for (const id of ["alpha", "beta"]) {
    mkdirSync(join(modulesDir, id, "migrations"), { recursive: true });
    writeFileSync(join(modulesDir, id, "manifest.ts"), `export default ${JSON.stringify(manifestOf(id))};\n`);
    writeFileSync(join(modulesDir, id, "package.json"), JSON.stringify({ name: `@fixture/${id}`, private: true }));
    writeFileSync(join(modulesDir, id, "migrations", "0001_init.sql"), "create table t (id int);");
  }
});
afterEach(() => {
  rmSync(modulesDir, { recursive: true, force: true });
});

type Cli = (args: string[]) => Promise<Outcome>;

async function withProvider(t: TestContext, reply: (path: string) => { status: number; body: unknown }, work: (db: pg.Pool, cli: Cli, url: string) => Promise<void>): Promise<void> {
  const scratch = await createScratchDatabase();
  if (!scratch.url) return t.skip(scratch.skipReason);
  const server = createServer((request, response) => {
    const { status, body } = reply(request.url ?? "");
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const db = createPool(scratch.url);
  const cli: Cli = (args) => run([...args, "--modules-dir", modulesDir], { DATABASE_URL: scratch.url!, MODUNEXO_MASTER_KEY: MASTER_KEY });
  try {
    assert.equal((await cli(["db:migrate"])).code, 0);
    assert.equal((await cli(["modules", "install", "alpha"])).code, 0);
    assert.equal((await cli(["modules", "install", "beta"])).code, 0);
    await work(db, cli, url);
  } finally {
    await db.end();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await scratch.drop();
  }
}

async function configure(db: pg.Pool, url: string, values: Record<string, string> = {}): Promise<void> {
  const registry = new Registry();
  registry.registerCore();
  registry.register(manifestOf("alpha") as never);
  const store = new SettingsService(db, registry, { masterKey: MASTER_KEY });
  for (const [key, value] of Object.entries({ "llm.url": `${url}/v1`, "llm.key": API_KEY, "llm.model": "m-b", ...values })) {
    if (value !== "") await store.set("alpha", key, value, "test");
  }
}

const models = { data: [{ id: "m-a" }, { id: "m-b" }, { id: "m-c" }] };

describe("cli: llm probe", () => {
  it("reaches the provider the settings name and says what it lists and whether the model is there", async (t) => {
    await withProvider(t, () => ({ status: 200, body: models }), async (db, cli, url) => {
      await configure(db, url);
      const out = await cli(["llm", "probe", "alpha"]);
      assert.equal(out.code, 0, out.stderr);
      const lines = out.stdout.trim().split("\n");
      assert.match(lines[0]!, new RegExp(`^reached ${url.replace(/[.]/g, "\\.")}/v1 in \\d+ ms$`));
      assert.equal(lines[1], "models (3): m-a, m-b, m-c");
      assert.equal(lines[2], 'model "m-b": available');
      assert.ok(!out.stdout.includes(API_KEY) && !out.stderr.includes(API_KEY), "the key is not printed");

      const json = JSON.parse((await cli(["llm", "probe", "alpha", "--json"])).stdout);
      assert.deepEqual([json.models, json.model, json.modelAvailable, typeof json.latencyMs], [["m-a", "m-b", "m-c"], "m-b", true, "number"]);

      await configure(db, url, { "llm.model": "missing" });
      assert.equal((await cli(["llm", "probe", "alpha"])).stdout.trim().split("\n")[2], 'model "missing": not listed by the provider');
    });
  });

  it("says no model is set when none is, and still lists what the provider has", async (t) => {
    await withProvider(t, () => ({ status: 200, body: models }), async (db, cli, url) => {
      await configure(db, url, { "llm.model": "" });
      const out = await cli(["llm", "probe", "alpha"]);
      assert.equal(out.code, 0, out.stderr);
      assert.equal(out.stdout.trim().split("\n")[2], "model: not set");
    });
  });

  it("refuses with exit code 3 when the module cannot call a model or the provider says no, and never prints the key", async (t) => {
    await withProvider(t, () => ({ status: 401, body: { error: { message: `bad key ${API_KEY}` } } }), async (db, cli, url) => {
      const unset = await cli(["llm", "probe", "alpha"]);
      assert.equal(unset.code, 3);
      assert.match(unset.stderr, /^refused: set the setting "llm\.url" of module "alpha"/);
      const plain = await cli(["llm", "probe", "beta"]);
      assert.equal(plain.code, 3);
      assert.match(plain.stderr, /module "beta" does not declare llm/);
      const ghost = await cli(["llm", "probe", "ghost"]);
      assert.equal(ghost.code, 3);
      assert.match(ghost.stderr, /module "ghost" is not registered/);

      await configure(db, url);
      const refused = await cli(["llm", "probe", "alpha"]);
      assert.equal(refused.code, 3);
      assert.match(refused.stderr, /^refused: the provider answered HTTP 401/);
      assert.ok(!refused.stdout.includes(API_KEY) && !refused.stderr.includes(API_KEY), "the key is not printed");
    });
  });

  it("answers a usage error, exit code 2, for missing arguments and bad options", async (t) => {
    await withProvider(t, () => ({ status: 200, body: models }), async (_db, cli) => {
      for (const [args, expected] of [
        [["llm"], /no llm command/],
        [["llm", "wipe"], /unknown llm command "wipe"/],
        [["llm", "probe"], /llm probe takes one module id/],
        [["llm", "probe", "a", "b"], /llm probe takes one module id/],
        [["llm", "probe", "alpha", "--limit", "3"], /option --limit does not apply to llm probe/],
        [["llm", "probe", "alpha", "--payload", "{}"], /option --payload does not apply to llm probe/],
      ] as Array<[string[], RegExp]>) {
        const outcome = await cli(args);
        assert.equal(outcome.code, 2, args.join(" "));
        assert.match(outcome.stderr, expected, args.join(" "));
      }
    });
  });
});
