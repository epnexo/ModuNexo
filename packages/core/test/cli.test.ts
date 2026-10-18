import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

/** Spawn the real script with only the environment it is given; never rejects, so exit codes can be asserted. */
const spawn = (args: string[], env: Record<string, string>): Promise<Outcome> =>
  new Promise((resolve) => {
    execFile(process.execPath, ["--import", "tsx", script, ...args], { env: { PATH: process.env.PATH, ...env } }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : ((error as { code?: number }).code ?? 1), stdout, stderr });
    });
  });

let modulesDir: string;
let outDir: string;
beforeEach(() => {
  modulesDir = mkdtempSync(join(tmpdir(), "modunexo-cli-modules-"));
  outDir = join(mkdtempSync(join(tmpdir(), "modunexo-cli-out-")), "web");
});
afterEach(() => {
  rmSync(modulesDir, { recursive: true, force: true });
  rmSync(join(outDir, ".."), { recursive: true, force: true });
});

interface FixtureOptions {
  version?: string;
  platform?: string;
  dependsOn?: Record<string, string>;
  pages?: unknown[];
  migrations?: Record<string, string>;
}

/** A neutral module package on disk: manifest, package.json and migrations. Writing it again replaces it. */
function writeModule(id: string, options: FixtureOptions = {}) {
  mkdirSync(join(modulesDir, id, "migrations"), { recursive: true });
  const manifest = {
    id,
    version: options.version ?? "1.0.0",
    name: id,
    platform: options.platform ?? "^0.1.0",
    dependsOn: options.dependsOn ?? {},
    schema: id,
    migrationsDir: "migrations",
    nav: [{ label: id, href: `/${id}`, group: "Fixtures", order: 1 }],
    ...(options.pages === undefined ? {} : { pages: options.pages }),
  };
  writeFileSync(join(modulesDir, id, "manifest.ts"), `export default ${JSON.stringify(manifest)};\n`);
  writeFileSync(join(modulesDir, id, "package.json"), JSON.stringify({ name: `@fixture/${id}`, private: true }));
  const migrations = options.migrations ?? { "0001_create.sql": "create table items (name text); insert into items values ('kept');" };
  for (const [name, sql] of Object.entries(migrations)) writeFileSync(join(modulesDir, id, "migrations", name), sql);
}

async function inScratchDatabase(t: TestContext, work: (url: string, db: pg.Pool, cli: (...args: string[]) => Promise<Outcome>) => Promise<void>): Promise<void> {
  const scratch = await createScratchDatabase();
  if (!scratch.url) return t.skip(scratch.skipReason);
  const url = scratch.url;
  const db = createPool(url, { connectionTimeoutMillis: 2000 });
  try {
    await work(url, db, (...args) => spawn([...args, "--modules-dir", modulesDir], { DATABASE_URL: url }));
  } finally {
    await db.end();
    await scratch.drop();
  }
}

const userSchemas = async (db: pg.Pool) =>
  (await db.query("select schema_name from information_schema.schemata where schema_name not in ('information_schema', 'public') and schema_name not like 'pg\\_%' order by 1")).rows.map((r) => r.schema_name as string);
const eventsOf = async (db: pg.Pool, id: string) =>
  (await db.query("select action, from_state, to_state, version, outcome from core.module_events where module_id = $1 order by id", [id])).rows.map((r) => [r.action, r.from_state, r.to_state, r.version, r.outcome]);

const REMINDER = /registry:generate.*rebuild and restart the web app/;

describe("cli: with no modules", () => {
  it("db:migrate creates only the core schema and registry:generate writes an empty registry", async (t) => {
    await inScratchDatabase(t, async (_url, db, cli) => {
      const migrated = await cli("db:migrate");
      assert.equal(migrated.code, 0, migrated.stderr);
      assert.deepEqual(await userSchemas(db), ["core"]);

      const list = await cli("modules", "list");
      assert.equal(list.code, 0, list.stderr);
      assert.match(list.stdout, /no modules/);
      assert.deepEqual(JSON.parse((await cli("modules", "list", "--json")).stdout), []);

      const dry = await cli("registry:generate", "--dry-run", "--out", outDir);
      assert.equal(dry.code, 0, dry.stderr);
      assert.match(dry.stdout, /dry run: would write 2 file\(s\), delete 0/);
      assert.equal(existsSync(outDir), false, "a dry run touches nothing");

      const generated = await cli("registry:generate", "--out", outDir);
      assert.equal(generated.code, 0, generated.stderr);
      assert.match(readFileSync(join(outDir, "src/generated/modules.ts"), "utf8"), /export const modules: readonly ModuleManifest\[\] = \[\];/);
      assert.equal(existsSync(join(outDir, "src/app/(shell)")), false);
    });
  });

  it("registry:generate works on a database that was never migrated", async (t) => {
    await inScratchDatabase(t, async (_url, _db, cli) => {
      const generated = await cli("registry:generate", "--out", outDir);
      assert.equal(generated.code, 0, generated.stderr);
      assert.ok(existsSync(join(outDir, "src/generated/modules.ts")));
    });
  });
});

describe("cli: the module journey", () => {
  it("installs, disables, enables, upgrades and uninstalls modules, auditing every transition", async (t) => {
    writeModule("alpha", { pages: [{ path: "/alpha", entry: "./web/page.tsx", kind: "page", dynamic: "force-dynamic" }, { path: "/alpha/export", entry: "./web/export.ts", kind: "route" }] });
    writeModule("beta", { dependsOn: { alpha: "^1.0.0" } });
    await inScratchDatabase(t, async (_url, db, cli) => {
      const listed = JSON.parse((await cli("modules", "list", "--json")).stdout) as { id: string; status: string }[];
      assert.deepEqual(listed.map((m) => [m.id, m.status]), [["alpha", "available"], ["beta", "available"]]);

      // beta needs alpha enabled first
      const early = await cli("modules", "install", "beta");
      assert.equal(early.code, 3, "a refusal has its own exit code");
      assert.match(early.stderr, /refused: module "beta" needs "alpha" to be enabled first/);
      assert.doesNotMatch(early.stdout, REMINDER, "nothing changed, nothing to regenerate");

      const installAlpha = await cli("modules", "install", "alpha");
      assert.equal(installAlpha.code, 0, installAlpha.stderr);
      assert.match(installAlpha.stdout, /installed "alpha" 1\.0\.0/);
      assert.match(installAlpha.stdout, REMINDER);
      assert.equal((await cli("modules", "install", "beta")).code, 0);

      // alpha cannot go while beta is enabled
      for (const args of [["disable", "alpha"], ["uninstall", "alpha", "--keep"]]) {
        const refused = await cli("modules", ...args);
        assert.equal(refused.code, 3, args.join(" "));
        assert.match(refused.stderr, /beta/);
      }

      assert.equal((await cli("modules", "disable", "beta")).code, 0);
      assert.equal((await cli("modules", "disable", "alpha")).code, 0);
      const stillBlocked = await cli("modules", "uninstall", "alpha", "--purge");
      assert.equal(stillBlocked.code, 3, "a disabled dependent still blocks an uninstall");
      assert.match(stillBlocked.stderr, /installed modules depend on "alpha": "beta"/);
      assert.equal((await cli("modules", "enable", "alpha")).code, 0);
      assert.equal((await cli("modules", "enable", "beta")).code, 0);

      // registration of the two enabled modules
      const generated = await cli("registry:generate", "--out", outDir);
      assert.equal(generated.code, 0, generated.stderr);
      assert.match(readFileSync(join(outDir, "src/generated/modules.ts"), "utf8"), /@fixture\/alpha\/manifest/);
      assert.match(readFileSync(join(outDir, "src/app/(shell)/alpha/page.tsx"), "utf8"), /export const dynamic = "force-dynamic";/);
      assert.ok(existsSync(join(outDir, "src/app/(shell)/alpha/export/route.ts")));

      // upgrade
      writeModule("alpha", { version: "1.1.0", migrations: { "0001_create.sql": "create table items (name text); insert into items values ('kept');", "0002_more.sql": "alter table items add column note text;" } });
      const pending = JSON.parse((await cli("modules", "list", "--json")).stdout) as { id: string; upgradePending: boolean }[];
      assert.equal(pending.find((m) => m.id === "alpha")?.upgradePending, true);
      assert.match((await cli("modules", "list")).stdout, /alpha\s+enabled\s+1\.1\.0\s+1\.0\.0\s+upgrade-pending/);
      const upgraded = await cli("modules", "upgrade", "alpha");
      assert.equal(upgraded.code, 0, upgraded.stderr);
      assert.match(upgraded.stdout, /upgraded "alpha" 1\.0\.0 -> 1\.1\.0/);
      assert.match(upgraded.stdout, REMINDER);
      const again = await cli("modules", "upgrade", "alpha");
      assert.equal(again.code, 0);
      assert.match(again.stdout, /"alpha" is already at 1\.1\.0; nothing to do/);
      assert.doesNotMatch(again.stdout, REMINDER);

      // uninstall needs a choice
      const noChoice = await cli("modules", "uninstall", "beta");
      assert.equal(noChoice.code, 3);
      assert.match(noChoice.stderr, /needs an explicit mode: keep .* or purge/);
      const both = await cli("modules", "uninstall", "beta", "--keep", "--purge");
      assert.equal(both.code, 2, "both flags is a usage error");
      assert.match(both.stderr, /--keep or --purge, not both/);

      const keep = await cli("modules", "uninstall", "beta", "--keep");
      assert.equal(keep.code, 0, keep.stderr);
      assert.match(keep.stdout, REMINDER);
      assert.ok((await userSchemas(db)).includes("beta"), "keep leaves the schema");
      const retained = JSON.parse((await cli("modules", "list", "--json")).stdout) as { id: string; dataRetained: boolean; status: string }[];
      assert.deepEqual(retained.filter((m) => m.id === "beta").map((m) => [m.status, m.dataRetained]), [["available", true]]);
      assert.match((await cli("modules", "list")).stdout, /beta\s+available.*data-retained/);

      const purge = await cli("modules", "uninstall", "alpha", "--purge");
      assert.equal(purge.code, 0, purge.stderr);
      assert.equal((await userSchemas(db)).includes("alpha"), false, "purge drops the schema");
      assert.equal((await db.query("select 1 from core.schema_migrations where module_id = 'alpha'")).rowCount, 0, "and its migration history");

      assert.deepEqual(await eventsOf(db, "alpha"), [
        ["install", "available", "enabled", "1.0.0", "ok"],
        ["disable", "enabled", "disabled", "1.0.0", "ok"],
        ["enable", "disabled", "enabled", "1.0.0", "ok"],
        ["upgrade", "enabled", "enabled", "1.1.0", "ok"],
        ["uninstall", "enabled", "available", "1.1.0", "ok"],
      ]);
      assert.deepEqual((await eventsOf(db, "beta")).map((e) => e[0]), ["install", "disable", "enable", "uninstall"]);

      // regenerating after the modules are gone removes their routes
      const afterwards = await cli("registry:generate", "--out", outDir);
      assert.equal(afterwards.code, 0, afterwards.stderr);
      assert.equal(existsSync(join(outDir, "src/app/(shell)/alpha")), false);
    });
  });

  it("refuses a module whose platform range the SDK does not satisfy, lists it, and does not break other commands", async (t) => {
    writeModule("future", { platform: "^9.0.0" });
    writeModule("alpha");
    await inScratchDatabase(t, async (_url, db, cli) => {
      const list = await cli("modules", "list");
      assert.equal(list.code, 0, list.stderr);
      assert.match(list.stdout, /future\s+available/);
      assert.equal((await cli("modules", "install", "alpha")).code, 0);

      const install = await cli("modules", "install", "future");
      assert.equal(install.code, 3);
      assert.match(install.stderr, /module "future" requires platform "\^9\.0\.0" but the SDK version is/);
      assert.equal((await userSchemas(db)).includes("future"), false);

      const migrate = await cli("db:migrate");
      assert.equal(migrate.code, 0, "a package that is not installed does not matter to db:migrate");
      assert.doesNotMatch(migrate.stderr, /future/);
      assert.equal((await userSchemas(db)).includes("future"), false);
    });
  });

  it("exits with 1, naming the step, when an accepted action fails", async (t) => {
    writeModule("alpha", { migrations: { "0001_broken.sql": "select * from does_not_exist;" } });
    await inScratchDatabase(t, async (_url, db, cli) => {
      const install = await cli("modules", "install", "alpha");
      assert.equal(install.code, 1);
      assert.match(install.stderr, /install of module "alpha" failed at step "migrations"/);
      assert.deepEqual((await eventsOf(db, "alpha")).map((e) => e[4]), ["failed"]);
    });
  });

  it("prints discovery warnings", async (t) => {
    writeModule("alpha");
    symlinkSync(join(modulesDir, "gone"), join(modulesDir, "dangling"), "dir");
    await inScratchDatabase(t, async (_url, _db, cli) => {
      const list = await cli("modules", "list");
      assert.equal(list.code, 0, list.stderr);
      assert.match(list.stderr, /warning: "dangling" is a symlink whose target cannot be read/);
    });
  });

  it("refuses to generate when two enabled modules claim one route", async (t) => {
    writeModule("alpha", { pages: [{ path: "/shared", entry: "./a.tsx", kind: "page" }] });
    writeModule("beta", { pages: [{ path: "/shared", entry: "./b.tsx", kind: "page" }] });
    await inScratchDatabase(t, async (_url, _db, cli) => {
      assert.equal((await cli("modules", "install", "alpha")).code, 0);
      assert.equal((await cli("modules", "install", "beta")).code, 0);
      const generated = await cli("registry:generate", "--out", outDir);
      assert.equal(generated.code, 3);
      assert.match(generated.stderr, /module "beta" declares "\/shared", which module "alpha" already declares/);
      assert.equal(existsSync(outDir), false, "nothing was written");
    });
  });
});

describe("cli: db:migrate and installed modules", () => {
  it("does not migrate, nor make look retained, a module that was never installed", async (t) => {
    writeModule("alpha");
    await inScratchDatabase(t, async (_url, db, cli) => {
      const migrated = await cli("db:migrate");
      assert.equal(migrated.code, 0, migrated.stderr);
      assert.doesNotMatch(migrated.stdout, /alpha/);
      assert.deepEqual(await userSchemas(db), ["core"]);

      const listed = JSON.parse((await cli("modules", "list", "--json")).stdout) as { id: string; status: string; dataRetained: boolean }[];
      assert.deepEqual(listed.map((m) => [m.id, m.status, m.dataRetained]), [["alpha", "available", false]]);
      assert.doesNotMatch((await cli("modules", "list")).stdout, /data-retained/);

      // installing is what applies the first migrations
      assert.equal((await cli("modules", "install", "alpha")).code, 0);
      assert.ok((await userSchemas(db)).includes("alpha"));
    });
  });

  it("leaves the migrations of an installed module to modules upgrade, so the version always matches the schema", async (t) => {
    writeModule("alpha");
    await inScratchDatabase(t, async (_url, db, cli) => {
      assert.equal((await cli("modules", "install", "alpha")).code, 0);
      const settled = await cli("db:migrate");
      assert.equal(settled.code, 0, settled.stderr);
      assert.match(settled.stdout, /nothing to apply/);
      assert.doesNotMatch(settled.stderr, /warning/);

      // A new file with an unchanged version: not applied, and the warning says what to do.
      writeModule("alpha", { migrations: { "0001_create.sql": "create table items (name text); insert into items values ('kept');", "0002_more.sql": "alter table items add column note text;" } });
      const sameVersion = await cli("db:migrate");
      assert.equal(sameVersion.code, 0, sameVersion.stderr);
      assert.match(sameVersion.stderr, /warning: module "alpha" has 1 pending migration\(s\) \(0002_more\.sql\).*raise its version.*modules upgrade alpha/);
      assert.doesNotMatch(sameVersion.stdout, /alpha/);
      assert.equal((await db.query("select 1 from information_schema.columns where table_schema = 'alpha' and column_name = 'note'")).rowCount, 0);

      // With a newer version the warning points straight at the upgrade, which applies the file and records the version.
      writeModule("alpha", { version: "1.1.0", migrations: { "0001_create.sql": "create table items (name text); insert into items values ('kept');", "0002_more.sql": "alter table items add column note text;" } });
      const newer = await cli("db:migrate");
      assert.match(newer.stderr, /module "alpha" has 1 pending migration\(s\).*run "modules upgrade alpha"/);
      assert.doesNotMatch(newer.stderr, /raise its version/);
      assert.equal((await cli("modules", "upgrade", "alpha")).code, 0);
      assert.equal((await db.query("select 1 from information_schema.columns where table_schema = 'alpha' and column_name = 'note'")).rowCount, 1);
      assert.equal((await db.query("select installed_version from core.modules where id = 'alpha'")).rows[0].installed_version, "1.1.0");
      assert.doesNotMatch((await cli("db:migrate")).stderr, /warning/);
    });
  });

  it("reports an installed module whose package is gone as a warning and carries on", async (t) => {
    writeModule("alpha");
    writeModule("beta");
    await inScratchDatabase(t, async (_url, _db, cli) => {
      assert.equal((await cli("modules", "install", "alpha")).code, 0);
      assert.equal((await cli("modules", "install", "beta")).code, 0);
      rmSync(join(modulesDir, "alpha"), { recursive: true });

      const migrated = await cli("db:migrate");
      assert.equal(migrated.code, 0, migrated.stderr);
      assert.match(migrated.stderr, /warning: module "alpha" is installed but its package is not on disk; skipped/);
      assert.doesNotMatch(migrated.stderr, /beta/);
      assert.match(migrated.stdout, /nothing to apply/);
    });
  });
});

describe("cli: usage", () => {
  const url = "postgres://u:p@127.0.0.1:1/x_test";
  const usage = async (args: string[], pattern: RegExp) => {
    const outcome = await spawn(args, { DATABASE_URL: url });
    assert.equal(outcome.code, 2, `${args.join(" ")}: ${outcome.stderr}`);
    assert.match(outcome.stderr, pattern);
  };

  it("rejects unknown commands, missing ids and options that do not belong to the command", async () => {
    await usage([], /usage:/);
    await usage(["frobnicate"], /unknown command "frobnicate"/);
    await usage(["modules"], /usage:/);
    await usage(["modules", "frobnicate"], /unknown modules command "frobnicate"/);
    await usage(["modules", "install"], /needs a module id/);
    await usage(["modules", "install", "a", "b"], /exactly one module id/);
    await usage(["modules", "list", "--keep"], /--keep.*does not apply to modules list/);
    await usage(["modules", "install", "a", "--purge"], /--purge.*does not apply to modules install/);
    await usage(["db:migrate", "--dry-run"], /--dry-run.*does not apply to db:migrate/);
    await usage(["registry:generate", "--json"], /--json.*does not apply to registry:generate/);
    await usage(["modules", "list", "--bogus"], /--bogus/);
  });

  it("rejects a --modules-dir that does not exist, for every command that reads modules", async () => {
    const missing = join(modulesDir, "nope");
    for (const args of [["modules", "list"], ["db:migrate"], ["registry:generate"]]) {
      await usage([...args, "--modules-dir", missing], /modules directory ".*nope" does not exist/);
    }
  });

  it("prints help and exits 0 on --help", async () => {
    const outcome = await spawn(["--help"], {});
    assert.equal(outcome.code, 0);
    assert.match(outcome.stdout, /modules install <id>/);
    assert.match(outcome.stdout, /registry:generate/);
  });

  it("fails with a clear message when DATABASE_URL is not set", async () => {
    const outcome = await spawn(["modules", "list", "--modules-dir", modulesDir], {});
    assert.equal(outcome.code, 1);
    assert.match(outcome.stderr, /DATABASE_URL is not set/);
  });
});
