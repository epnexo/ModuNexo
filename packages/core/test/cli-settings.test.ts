import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type TestContext, afterEach, beforeEach, describe, it } from "node:test";
import type pg from "pg";
import { createPool } from "../src/pool.ts";
import { createScratchDatabase } from "../src/testing.ts";

const script = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
const MASTER_KEY = "c".repeat(40);
const SECRET = "tok_live_cli_9f8e7d6c";

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

let modulesDir: string;
beforeEach(() => {
  modulesDir = mkdtempSync(join(tmpdir(), "epnexo-cli-settings-"));
  mkdirSync(join(modulesDir, "alpha", "migrations"), { recursive: true });
  const manifest = {
    id: "alpha",
    version: "1.0.0",
    name: "Alpha",
    platform: "^0.1.0",
    dependsOn: {},
    schema: "alpha",
    migrationsDir: "migrations",
    nav: [],
    settings: [
      { key: "site.title", label: "Site title", type: "string", default: "Untitled" },
      { key: "page.size", label: "Page size", type: "number", default: 25 },
      { key: "export.dir", label: "Export directory", type: "path", required: true },
      { key: "api.token", label: "API token", type: "secret", required: true },
    ],
  };
  writeFileSync(join(modulesDir, "alpha", "manifest.ts"), `export default ${JSON.stringify(manifest)};\n`);
  writeFileSync(join(modulesDir, "alpha", "package.json"), JSON.stringify({ name: "@fixture/alpha", private: true }));
  writeFileSync(join(modulesDir, "alpha", "migrations", "0001_init.sql"), "create table t (id int);");
});
afterEach(() => rmSync(modulesDir, { recursive: true, force: true }));

type Cli = (args: string[], options?: { stdin?: string; masterKey?: boolean | string }) => Promise<Outcome>;

async function inScratchDatabase(t: TestContext, work: (db: pg.Pool, cli: Cli) => Promise<void>, migrated = true): Promise<void> {
  const scratch = await createScratchDatabase();
  if (!scratch.url) return t.skip(scratch.skipReason);
  const url = scratch.url;
  const db = createPool(url);
  const cli: Cli = (args, options = {}) =>
    spawn(
      [...args, "--modules-dir", modulesDir],
      { DATABASE_URL: url, ...(options.masterKey === false ? {} : { EPNEXO_MASTER_KEY: typeof options.masterKey === "string" ? options.masterKey : MASTER_KEY }) },
      options.stdin,
    );
  try {
    if (migrated) assert.equal((await cli(["db:migrate"])).code, 0);
    await work(db, cli);
  } finally {
    await db.end();
    await scratch.drop();
  }
}

describe("cli: settings, platform appearance", () => {
  it("lists the appearance with its defaults, without the master key", async (t) => {
    await inScratchDatabase(t, async (_db, cli) => {
      const result = await cli(["settings", "list"], { masterKey: false });
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /appearance\.theme\s+select\s+system\s+default/);
      assert.match(result.stdout, /appearance\.accentHue\s+number\s+258\s+default/);
      assert.match(result.stdout, /appearance\.radius\s+select\s+default\s+default/);
    });
  });

  it("sets, reads and clears a value, and refuses an invalid one with exit code 3", async (t) => {
    await inScratchDatabase(t, async (db, cli) => {
      const set = await cli(["settings", "set", "appearance.accentHue", "140"], { masterKey: false });
      assert.equal(set.code, 0, set.stderr);
      assert.equal(set.stdout.trim(), "set appearance.accentHue");
      assert.equal((await cli(["settings", "get", "appearance.accentHue"], { masterKey: false })).stdout.trim(), "140");

      const bad = await cli(["settings", "set", "appearance.accentHue", "999"], { masterKey: false });
      assert.equal(bad.code, 3);
      assert.match(bad.stderr, /^refused: appearance\.accentHue: must be a number from 0 to 360/);
      assert.equal((await cli(["settings", "get", "appearance.accentHue"], { masterKey: false })).stdout.trim(), "140");

      const unset = await cli(["settings", "unset", "appearance.accentHue"], { masterKey: false });
      assert.equal(unset.code, 0);
      assert.equal((await cli(["settings", "get", "appearance.accentHue"], { masterKey: false })).stdout.trim(), "258");
      const events = await db.query("select scope, key, action, actor from core.settings_events order by id");
      assert.deepEqual(events.rows, [
        { scope: "platform", key: "appearance.accentHue", action: "set", actor: "cli" },
        { scope: "platform", key: "appearance.accentHue", action: "unset", actor: "cli" },
      ]);
    });
  });
});

describe("cli: settings, module settings", () => {
  it("lists the declared settings with defaults, sources and what is incomplete", async (t) => {
    await inScratchDatabase(t, async (_db, cli) => {
      const result = await cli(["settings", "list", "--module", "alpha"]);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /site\.title\s+string\s+Untitled\s+default/);
      assert.match(result.stdout, /page\.size\s+number\s+25\s+default/);
      assert.match(result.stdout, /export\.dir\s+path\s+-\s+unset\s+incomplete/);
      assert.match(result.stdout, /api\.token\s+secret\s+\(secret\) not set\s+unset\s+incomplete/);
    });
  });

  it("sets typed values, prints them as JSON on request, and clears them", async (t) => {
    await inScratchDatabase(t, async (_db, cli) => {
      assert.equal((await cli(["settings", "set", "page.size", "50", "--module", "alpha"])).code, 0);
      assert.equal((await cli(["settings", "set", "export.dir", "/srv/exports", "--module", "alpha"])).code, 0);
      assert.equal((await cli(["settings", "get", "page.size", "--module", "alpha"])).stdout.trim(), "50");
      const json = JSON.parse((await cli(["settings", "list", "--module", "alpha", "--json"])).stdout);
      const size = json.find((e: { key: string }) => e.key === "page.size");
      assert.deepEqual({ effective: size.effective, source: size.source }, { effective: 50, source: "stored" });
      assert.equal((await cli(["settings", "unset", "page.size", "--module", "alpha"])).code, 0);
      assert.equal((await cli(["settings", "get", "page.size", "--module", "alpha"])).stdout.trim(), "25");
    });
  });

  it("refuses an invalid value with exit code 3 naming the key", async (t) => {
    await inScratchDatabase(t, async (_db, cli) => {
      const result = await cli(["settings", "set", "page.size", "lots", "--module", "alpha"]);
      assert.equal(result.code, 3);
      assert.match(result.stderr, /^refused: page\.size: must be a number/);
    });
  });

  it("refuses an unknown module and an undeclared key with exit code 3", async (t) => {
    await inScratchDatabase(t, async (_db, cli) => {
      const module = await cli(["settings", "list", "--module", "nope"]);
      assert.equal(module.code, 3);
      assert.match(module.stderr, /module "nope" is not registered/);
      const key = await cli(["settings", "get", "not.declared", "--module", "alpha"]);
      assert.equal(key.code, 3);
      assert.match(key.stderr, /does not declare a setting "not\.declared"/);
    });
  });

  it("needs --module for anything that is not appearance", async (t) => {
    await inScratchDatabase(t, async (_db, cli) => {
      const result = await cli(["settings", "get", "page.size"]);
      assert.equal(result.code, 2);
      assert.match(result.stderr, /--module/);
    });
  });
});

describe("cli: settings, secrets", () => {
  it("reads a secret from standard input, never prints it, and shows only that it is set", async (t) => {
    await inScratchDatabase(t, async (db, cli) => {
      const set = await cli(["settings", "set", "api.token", "--module", "alpha"], { stdin: `${SECRET}\n` });
      assert.equal(set.code, 0, set.stderr);
      assert.ok(!`${set.stdout}${set.stderr}`.includes(SECRET));
      const list = await cli(["settings", "list", "--module", "alpha"]);
      assert.match(list.stdout, /api\.token\s+secret\s+\(secret\) set\s+stored/);
      assert.ok(!list.stdout.includes(SECRET));
      const get = await cli(["settings", "get", "api.token", "--module", "alpha"]);
      assert.equal(get.stdout.trim(), "(secret) set");
      const json = await cli(["settings", "list", "--module", "alpha", "--json"]);
      assert.ok(!json.stdout.includes(SECRET));
      const row = (await db.query("select secret from core.module_settings where key = 'api.token'")).rows[0];
      assert.ok(row.secret.startsWith("v1.") && !row.secret.includes(SECRET));
    });
  });

  it("refuses a secret given as an argument with exit code 2, and an empty one on standard input with 3", async (t) => {
    await inScratchDatabase(t, async (db, cli) => {
      const argument = await cli(["settings", "set", "api.token", SECRET, "--module", "alpha"]);
      assert.equal(argument.code, 2);
      assert.ok(!`${argument.stdout}${argument.stderr}`.includes(SECRET));
      const empty = await cli(["settings", "set", "api.token", "--module", "alpha"], { stdin: "" });
      assert.equal(empty.code, 3);
      assert.equal((await db.query("select 1 from core.module_settings")).rowCount, 0);
    });
  });

  it("needs the master key for module settings and names the variable", async (t) => {
    await inScratchDatabase(t, async (_db, cli) => {
      const result = await cli(["settings", "list", "--module", "alpha"], { masterKey: false });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /EPNEXO_MASTER_KEY/);
    });
  });

  it("reports a secret that another master key encrypted as unreadable, and exits 1 on get without printing anything secret", async (t) => {
    await inScratchDatabase(t, async (_db, cli) => {
      await cli(["settings", "set", "api.token", "--module", "alpha"], { stdin: `${SECRET}\n` });
      const other = "o".repeat(40);
      const list = await cli(["settings", "list", "--module", "alpha"], { masterKey: other });
      assert.equal(list.code, 0, list.stderr);
      assert.match(list.stdout, /api\.token\s+secret\s+\(secret\) unreadable/);
      const get = await cli(["settings", "get", "api.token", "--module", "alpha"], { masterKey: other });
      assert.equal(get.code, 1);
      assert.match(get.stderr, /cannot be read/);
      assert.ok(!`${get.stdout}${get.stderr}`.includes(SECRET) && !get.stderr.includes(other) && !get.stderr.includes(MASTER_KEY));
      const replaced = await cli(["settings", "set", "api.token", "--module", "alpha"], { masterKey: other, stdin: "replacement-value-1\n" });
      assert.equal(replaced.code, 0, replaced.stderr);
    });
  });
});

describe("cli: settings, module appearance", () => {
  it("overrides a module's accent and shows it, then goes back to following the platform", async (t) => {
    await inScratchDatabase(t, async (_db, cli) => {
      await cli(["settings", "set", "appearance.accentHue", "140"], { masterKey: false });
      let list = await cli(["settings", "list", "--module", "alpha"]);
      assert.match(list.stdout, /appearance\.accentHue\s+number\s+140\s+platform/);

      assert.equal((await cli(["settings", "set", "appearance.accentHue", "20", "--module", "alpha"])).code, 0);
      list = await cli(["settings", "list", "--module", "alpha"]);
      assert.match(list.stdout, /appearance\.accentHue\s+number\s+20\s+stored/);

      assert.equal((await cli(["settings", "unset", "appearance.accentHue", "--module", "alpha"])).code, 0);
      list = await cli(["settings", "list", "--module", "alpha"]);
      assert.match(list.stdout, /appearance\.accentHue\s+number\s+140\s+platform/);
    });
  });

  it("refuses to read a module's appearance for a module that is not registered", async (t) => {
    await inScratchDatabase(t, async (_db, cli) => {
      const result = await cli(["settings", "get", "appearance.accentHue", "--module", "nope"], { masterKey: false });
      assert.equal(result.code, 3);
      assert.match(result.stderr, /module "nope" is not registered/);
    });
  });

  it("does not let a module override the theme", async (t) => {
    await inScratchDatabase(t, async (_db, cli) => {
      const result = await cli(["settings", "set", "appearance.theme", "dark", "--module", "alpha"]);
      assert.equal(result.code, 3);
      assert.match(result.stderr, /theme/);
    });
  });
});

describe("cli: settings, usage and failure", () => {
  it("is a usage error without a subcommand, with an unknown one, a missing key or too many arguments", async (t) => {
    await inScratchDatabase(t, async (_db, cli) => {
      for (const args of [["settings"], ["settings", "show"], ["settings", "get"], ["settings", "unset"], ["settings", "set"], ["settings", "set", "a", "b", "c"], ["settings", "list", "extra"], ["settings", "list", "--module"]]) {
        assert.equal((await cli(args, { masterKey: false })).code, 2, args.join(" "));
      }
    });
  });

  it("fails with exit code 1 and points at db:migrate when the database was never migrated", async (t) => {
    await inScratchDatabase(
      t,
      async (_db, cli) => {
        const result = await cli(["settings", "list"], { masterKey: false });
        assert.equal(result.code, 1);
        assert.match(result.stderr, /npm run db:migrate/);
      },
      false,
    );
  });

  it("is listed in --help", async () => {
    const result = await spawn(["--help"], {});
    assert.match(result.stdout, /settings list/);
    assert.match(result.stdout, /settings set/);
    assert.match(result.stdout, /--module/);
  });
});
