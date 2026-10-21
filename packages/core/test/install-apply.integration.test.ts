import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SDK_VERSION } from "@modunexo/sdk";
import { afterEach, beforeEach, describe, it } from "node:test";
import type pg from "pg";
import { REGISTRY_FILE } from "../src/codegen/render.ts";
import { generateRegistration } from "../src/codegen/generate.ts";
import { ApplyFailedError, ApplyRefusedError, applyPackage } from "../src/install/apply.ts";
import { distRecordPath, readLiveDist } from "../src/install/dist.ts";
import { readJournal, writeJournal } from "../src/install/journal.ts";
import { recoverInterrupted } from "../src/install/recover.ts";
import { placePackage } from "../src/install/place.ts";
import type { BuildRunner } from "../src/install/build.ts";
import { BuildFailedError } from "../src/install/build.ts";
import { listOperations, startOperation } from "../src/operations/index.ts";
import { buildPackageContext, intakePackage } from "../src/packages/index.ts";
import { createPool } from "../src/pool.ts";
import { Registry } from "../src/registry.ts";
import { migrate } from "../src/runner.ts";
import { createScratchDatabase } from "../src/testing.ts";
import { type PackageOptions, packageEntries } from "./helpers/package-fixture.ts";
import { tgz } from "./helpers/tarball.ts";

let work: string;
let pool: pg.Pool;
let drop: (() => Promise<void>) | undefined;
let skipReason: string | undefined;

const paths = () => ({ repoRoot: work, modulesDir: join(work, "modules"), webRoot: join(work, "web"), dataDir: join(work, "var") });

beforeEach(async () => {
  work = mkdtempSync(join(tmpdir(), "modunexo-apply-"));
  mkdirSync(join(work, "modules"));
  mkdirSync(join(work, "node_modules"));
  mkdirSync(join(work, "web"));
  generateRegistration([], { outDir: join(work, "web") });
  mkdirSync(join(work, "web", ".next"));
  writeFileSync(join(work, "web", ".next", "BUILD_ID"), "old");
  writeFileSync(join(work, "web", "tsconfig.json"), JSON.stringify({ include: ["src", ".next/types/**/*.ts"] }));
  const scratch = await createScratchDatabase();
  skipReason = scratch.url ? undefined : scratch.skipReason;
  if (!scratch.url) return;
  drop = scratch.drop;
  pool = createPool(scratch.url);
  const registry = new Registry();
  registry.registerCore();
  await migrate(pool, registry);
});
afterEach(async () => {
  if (drop) await pool.end().then(drop);
  drop = undefined;
  rmSync(work, { recursive: true, force: true });
});

const test = (name: string, run: () => Promise<void>) =>
  it(name, async (t) => {
    await Promise.resolve();
    if (skipReason !== undefined) return t.skip(skipReason);
    await run();
  });

/** Brings a package in through the real intake and returns its SHA-256. */
async function stage(options: PackageOptions = {}): Promise<string> {
  const file = join(work, `pkg-${Math.random().toString(36).slice(2)}.tgz`);
  writeFileSync(file, tgz(packageEntries(options)));
  const context = await buildPackageContext({ modulesDir: paths().modulesDir, repoRoot: work, pool });
  const result = await intakePackage({ pool, archive: file, dataDir: paths().dataDir, context, actor: "apply-test" });
  assert.equal(result.ok, true, JSON.stringify(result));
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

const builds: string[] = [];
/** What the serving build's BUILD_ID was while each build ran: a build must not touch it. */
const servingDuringBuild: string[] = [];
const goodBuild: BuildRunner = async (webRoot, _signal, dist) => {
  builds.push(readFileSync(join(webRoot, REGISTRY_FILE), "utf8"));
  servingDuringBuild.push(readFileSync(join(webRoot, readLiveDist(webRoot, paths().dataDir).name, "BUILD_ID"), "utf8"));
  mkdirSync(join(webRoot, dist!), { recursive: true });
  writeFileSync(join(webRoot, dist!, "BUILD_ID"), "new");
  return { code: 0, output: "ok" };
};
const badBuild: BuildRunner = async () => ({ code: 1, output: "Type error: boom" });
beforeEach(() => {
  builds.length = 0;
  servingDuringBuild.length = 0;
});

const restarts: string[] = [];
const requestRestart = async () => {
  restarts.push("asked");
  return "restart requested";
};
beforeEach(() => {
  restarts.length = 0;
});

const apply = (sha256: string, run: BuildRunner = goodBuild, afterPreflight?: () => Promise<void>) =>
  applyPackage({ pool, sha256, actor: "apply-test", ...paths(), run, requestRestart, ...(afterPreflight === undefined ? {} : { afterPreflight }) });
const modulesRows = async () => (await pool.query("select id, state, installed_version from core.modules order by id")).rows;
/** The BUILD_ID of the build the server would serve if it restarted now. */
const buildId = () => readFileSync(join(work, "web", readLiveDist(join(work, "web"), paths().dataDir).name, "BUILD_ID"), "utf8");
/** Every build directory and per-directory tsconfig in the web folder. */
const buildDirs = () => readdirSync(join(work, "web")).filter((name) => name.startsWith(".next") || name.startsWith("tsconfig.next")).sort();
const schemaExists = async (name: string) => (await pool.query("select 1 from information_schema.schemata where schema_name = $1", [name])).rowCount === 1;

describe("applyPackage: install", () => {
  test("places, builds with the module registered, installs through the lifecycle, restarts, and records the run", async () => {
    const sha = await stage({ files: { "migrations/0001_init.sql": "create table items (id int);\n" } });
    const result = await apply(sha);
    assert.deepEqual({ id: result.moduleId, version: result.version, kind: result.kind, restart: result.restart }, { id: "reports", version: "1.0.0", kind: "install", restart: "restart requested" });
    assert.deepEqual(await modulesRows(), [{ id: "reports", state: "enabled", installed_version: "1.0.0" }]);
    assert.ok(existsSync(join(work, "modules", "reports", "manifest.ts")));
    assert.ok(lstatSync(join(work, "node_modules", "@acme", "reports")).isSymbolicLink());
    assert.equal(realpathSync(join(work, "node_modules", "@acme", "reports")), join(work, "modules", "reports"));
    assert.equal(builds.length, 1);
    assert.match(builds[0]!, /reports/);
    assert.equal(buildId(), "new");
    assert.deepEqual(servingDuringBuild, ["old"], "the build that was serving was untouched while the new one was made");
    assert.notEqual(readLiveDist(join(work, "web"), paths().dataDir).name, ".next", "the new build is in its own directory, and the record names it");
    assert.equal(readFileSync(join(work, "web", ".next", "BUILD_ID"), "utf8"), "old", "the old directory stays for the server that is draining");
    assert.equal(restarts.length, 1);
    assert.ok(await schemaExists("reports"));
    const [run] = await listOperations(pool, { moduleId: "reports" });
    assert.deepEqual({ status: run!.status, kind: run!.kind, sha256: run!.sha256, actor: run!.actor }, { status: "succeeded", kind: "install", sha256: sha, actor: "apply-test" });
    assert.deepEqual(readdirSync(join(work, "web")).filter((name) => name.includes("rollback")), []);
  });

  test("a build that fails leaves the database, the folder, the link and the old build as they were", async () => {
    const sha = await stage();
    await assert.rejects(apply(sha, badBuild), (error) => {
      assert.ok(error instanceof ApplyFailedError);
      assert.equal(error.step, "build");
      assert.ok(error.cause instanceof BuildFailedError);
      return true;
    });
    assert.deepEqual(await modulesRows(), []);
    assert.equal(await schemaExists("reports"), false);
    assert.deepEqual(readdirSync(join(work, "modules")), []);
    assert.deepEqual(readdirSync(join(work, "node_modules")), []);
    assert.equal(buildId(), "old");
    assert.deepEqual(buildDirs(), [".next"], "the failed build's directory and tsconfig are gone");
    assert.equal(existsSync(distRecordPath(paths().dataDir)), false, "nothing was switched");
    assert.doesNotMatch(readFileSync(join(work, "web", REGISTRY_FILE), "utf8"), /reports/);
    assert.equal(restarts.length, 0);
    const [run] = await listOperations(pool, { moduleId: "reports" });
    assert.equal(run!.status, "rolled_back");
    assert.match(run!.detail ?? "", /build/);
  });

  test("a migration that fails undoes the build and the files, and says what the database kept", async () => {
    const sha = await stage({ files: { "migrations/0001_init.sql": "create table items (id int);\n", "migrations/0002_bad.sql": "select * from nowhere;\n" } });
    await assert.rejects(apply(sha), (error) => {
      assert.ok(error instanceof ApplyFailedError);
      assert.equal(error.step, "lifecycle");
      return true;
    });
    assert.deepEqual(await modulesRows(), []);
    assert.deepEqual(readdirSync(join(work, "modules")), []);
    assert.deepEqual(readdirSync(join(work, "node_modules")), []);
    assert.equal(buildId(), "old");
    assert.equal(restarts.length, 0);
    const [run] = await listOperations(pool, { moduleId: "reports" });
    assert.equal(run!.status, "rolled_back");
    assert.match(run!.detail ?? "", /not undone/i);
  });

  test("a manifest.ts that is not the manifest.json that was reviewed is refused and undone", async () => {
    const sha = await stage({ files: { "manifest.ts": `export default ${JSON.stringify({ id: "reports", version: "1.0.0", name: "Sneaky", platform: `^${SDK_VERSION}`, dependsOn: {}, schema: "reports", migrationsDir: "migrations", nav: [], pages: [] })};\n` } });
    await assert.rejects(apply(sha), (error) => {
      assert.ok(error instanceof ApplyRefusedError);
      assert.match(error.message, /manifest\.ts/);
      return true;
    });
    assert.deepEqual(await modulesRows(), []);
    assert.deepEqual(readdirSync(join(work, "modules")), []);
    assert.equal(builds.length, 0, "nothing was built");
  });
});

describe("applyPackage: upgrade", () => {
  test("replaces the folder, keeps the previous one, applies the new migrations and records an upgrade", async () => {
    await apply(await stage({ files: { "migrations/0001_init.sql": "create table items (id int);\n" } }));
    const sha = await stage({ version: "1.1.0", files: { "migrations/0001_init.sql": "create table items (id int);\n", "migrations/0002_more.sql": "alter table items add column name text;\n" } });
    const result = await apply(sha);
    assert.equal(result.kind, "upgrade");
    assert.deepEqual(await modulesRows(), [{ id: "reports", state: "enabled", installed_version: "1.1.0" }]);
    assert.equal(JSON.parse(readFileSync(join(work, "modules", "reports", "package.json"), "utf8")).version, "1.1.0");
    assert.ok(existsSync(join(paths().dataDir, "previous", "reports-1.0.0", "package.json")));
    const columns = await pool.query("select column_name from information_schema.columns where table_schema = 'reports' and table_name = 'items'");
    assert.ok(columns.rows.some((row) => row.column_name === "name"));
    assert.equal(builds.length, 2);
    assert.match(builds[1]!, /@acme\/reports\/manifest/, "the module stays registered through its upgrade");
  });

  test("a failed upgrade build puts the previous version back", async () => {
    await apply(await stage());
    const sha = await stage({ version: "1.1.0" });
    await assert.rejects(apply(sha, badBuild), ApplyFailedError);
    assert.equal(JSON.parse(readFileSync(join(work, "modules", "reports", "package.json"), "utf8")).version, "1.0.0");
    assert.deepEqual(await modulesRows(), [{ id: "reports", state: "enabled", installed_version: "1.0.0" }]);
    assert.equal(existsSync(join(paths().dataDir, "previous", "reports-1.0.0")), false);
    assert.equal(buildId(), "new", "the build of 1.0.0 is back");
  });

  test("the same version, or an older one, is refused before anything is placed", async () => {
    await apply(await stage({ version: "1.1.0" }));
    const sameSha = await stage({ version: "1.1.0", files: { "web/page.tsx": "export default function Page() { return 'same'; }\n" } });
    await assert.rejects(apply(sameSha), ApplyRefusedError);
    const older = await stage({ version: "1.0.0" });
    await assert.rejects(apply(older), /older|newer|downgrade|greater/i);
    assert.equal(JSON.parse(readFileSync(join(work, "modules", "reports", "package.json"), "utf8")).version, "1.1.0");
    assert.equal(readdirSync(paths().dataDir).includes("previous"), false);
  });
});

describe("applyPackage: the state is read again under the lock", () => {
  test("an install whose module appeared in the meantime is refused, nothing is placed or built, the run is closed", async () => {
    const sha = await stage();
    const stale = apply(sha, goodBuild, async () => void (await pool.query("insert into core.modules (id, state, installed_version) values ('reports', 'enabled', '0.5.0')")));
    await assert.rejects(stale, (error) => error instanceof ApplyRefusedError && /changed/.test(error.message));
    assert.deepEqual(readdirSync(join(work, "modules")), []);
    assert.equal(builds.length, 0);
    const [run] = await listOperations(pool, { moduleId: "reports", limit: 1 });
    assert.equal(run!.status, "failed");
    assert.match(run!.detail ?? "", /changed/);
  });
});

describe("applyPackage: refusals", () => {
  test("an unknown SHA-256 and a refused package are not applied", async () => {
    await assert.rejects(applyPackage({ pool, sha256: "e".repeat(64), actor: "apply-test", ...paths(), run: goodBuild, requestRestart }), ApplyRefusedError);
    const file = join(work, "bad.tgz");
    writeFileSync(file, tgz(packageEntries({ packageJson: { dependencies: { "left-pad": "^1.0.0" } } })));
    const context = await buildPackageContext({ modulesDir: paths().modulesDir, repoRoot: work, pool });
    const refused = await intakePackage({ pool, archive: file, dataDir: paths().dataDir, context, actor: "apply-test" });
    assert.equal(refused.ok, false);
    await assert.rejects(applyPackage({ pool, sha256: refused.sha256, actor: "apply-test", ...paths(), run: goodBuild, requestRestart }), /refused|not staged/i);
    assert.equal(builds.length, 0);
  });

  test("while another run is in progress it is refused and touches nothing", async () => {
    const sha = await stage();
    await startOperation(pool, { moduleId: "other", version: "1.0.0", sha256: "b".repeat(64), kind: "install", actor: "apply-test" });
    await assert.rejects(apply(sha), (error) => error instanceof ApplyRefusedError && /another operation/.test(error.message));
    assert.deepEqual(readdirSync(join(work, "modules")), []);
    assert.equal(builds.length, 0);
  });

  test("a staged tree that has gone missing is refused", async () => {
    const sha = await stage();
    rmSync(join(paths().dataDir, "staging", sha), { recursive: true });
    await assert.rejects(apply(sha), ApplyRefusedError);
  });
});

describe("applyPackage: interruption", () => {
  test("a stop signal during the build rolls everything back and ends the run rolled_back", async () => {
    await apply(await stage());
    const sha = await stage({ version: "1.1.0" });
    const slow: BuildRunner = (_webRoot, signal) =>
      new Promise((resolve) => {
        signal?.addEventListener("abort", () => resolve({ code: 130, output: "interrupted" }));
        setTimeout(() => process.emit("SIGINT"), 50);
      });
    await assert.rejects(apply(sha, slow), (error) => error instanceof ApplyFailedError && /interrupt/i.test(error.message));
    assert.equal(JSON.parse(readFileSync(join(work, "modules", "reports", "package.json"), "utf8")).version, "1.0.0");
    assert.equal(buildId(), "new", "the build of 1.0.0 is back");
    assert.deepEqual((await modulesRows())[0]!.installed_version, "1.0.0");
    const [run] = await listOperations(pool, { moduleId: "reports", limit: 1 });
    assert.equal(run!.status, "rolled_back");
    assert.equal(existsSync(join(paths().dataDir, "run", "apply.journal.json")), false);
  });

  test("a run that died mid-build is recovered by the next apply, which then goes through", async () => {
    await apply(await stage());
    const sha = await stage({ version: "1.1.0" });
    const serving = readLiveDist(join(work, "web"), paths().dataDir).name;
    // What a killed process leaves behind: the new version placed, the old one aside, a half build in its own
    // directory, a journal that names it, and a run that is `running` under a pid that no longer exists.
    const placement = placePackage({
      stagingDir: join(paths().dataDir, "staging", sha),
      moduleId: "reports",
      packageName: "@acme/reports",
      version: "1.1.0",
      kind: "upgrade",
      previousVersion: "1.0.0",
      modulesDir: paths().modulesDir,
      nodeModulesDir: join(work, "node_modules"),
      dataDir: paths().dataDir,
      beforeChange: (state) => writeJournal(paths().dataDir, { ...state, version: "1.1.0", phase: "building", webRoot: paths().webRoot, dist: ".next-crashed" }),
    });
    assert.ok(placement.previousDir);
    mkdirSync(join(work, "web", ".next-crashed"));
    writeFileSync(join(work, "web", ".next-crashed", "partial"), "x");
    writeFileSync(join(work, "web", "tsconfig.next-crashed.json"), "{}");
    await startOperation(pool, { moduleId: "reports", version: "1.1.0", sha256: sha, kind: "upgrade", actor: "apply-test", pid: 2 ** 22 + 4321 });

    const result = await apply(sha);
    assert.equal(result.kind, "upgrade");
    assert.match(result.warnings.join("\n"), /recovered/i);
    assert.deepEqual(await modulesRows(), [{ id: "reports", state: "enabled", installed_version: "1.1.0" }]);
    assert.equal(JSON.parse(readFileSync(join(work, "modules", "reports", "package.json"), "utf8")).version, "1.1.0");
    assert.equal(existsSync(join(work, "web", ".next-crashed")), false, "the half build is gone");
    assert.equal(existsSync(join(work, "web", "tsconfig.next-crashed.json")), false);
    assert.equal(existsSync(join(work, "web", ".next", "BUILD_ID")), true, "the build that was serving was never touched");
    assert.notEqual(readLiveDist(join(work, "web"), paths().dataDir).name, serving, "and the run that followed switched to its own build");
    const statuses = (await listOperations(pool, { moduleId: "reports", limit: 5 })).map((run) => run.status);
    assert.deepEqual(statuses, ["succeeded", "failed", "succeeded"]);
  });

  test("a journal from before builds had directories of their own is still recovered: the kept .next.rollback comes back", async () => {
    await apply(await stage());
    const sha = await stage({ version: "1.1.0" });
    const placement = placePackage({
      stagingDir: join(paths().dataDir, "staging", sha),
      moduleId: "reports",
      packageName: "@acme/reports",
      version: "1.1.0",
      kind: "upgrade",
      previousVersion: "1.0.0",
      modulesDir: paths().modulesDir,
      nodeModulesDir: join(work, "node_modules"),
      dataDir: paths().dataDir,
      beforeChange: (state) => writeJournal(paths().dataDir, { ...state, version: "1.1.0", phase: "building", webRoot: paths().webRoot }),
    });
    assert.ok(placement.previousDir);
    const { renameSync } = await import("node:fs");
    renameSync(join(work, "web", ".next"), join(work, "web", ".next.rollback"));
    mkdirSync(join(work, "web", ".next"));
    writeFileSync(join(work, "web", ".next", "partial"), "x");
    await startOperation(pool, { moduleId: "reports", version: "1.1.0", sha256: sha, kind: "upgrade", actor: "apply-test", pid: 2 ** 22 + 4322 });
    const notes = await recoverInterrupted({ pool, ...paths() });
    assert.match(notes.join("\n"), /put back/);
    assert.equal(existsSync(join(work, "web", ".next", "partial")), false);
    assert.equal(readFileSync(join(work, "web", ".next", "BUILD_ID"), "utf8"), "old");
    assert.equal(existsSync(join(work, "web", ".next.rollback")), false);
  });
});

describe("applyPackage: other rules", () => {
  test("an upgrade of a disabled module does not put it into the build", async () => {
    await apply(await stage());
    await pool.query("update core.modules set state = 'disabled' where id = 'reports'");
    const sha = await stage({ version: "1.1.0" });
    builds.length = 0;
    await apply(sha);
    assert.equal(builds.length, 1);
    assert.doesNotMatch(builds[0]!, /reports/);
    assert.deepEqual((await modulesRows())[0], { id: "reports", state: "disabled", installed_version: "1.1.0" });
  });

  test("a previous-version folder that already exists does not block an upgrade", async () => {
    await apply(await stage());
    mkdirSync(join(paths().dataDir, "previous", "reports-1.0.0"), { recursive: true });
    const result = await apply(await stage({ version: "1.1.0" }));
    assert.equal(result.kind, "upgrade");
    assert.ok(readdirSync(join(paths().dataDir, "previous")).filter((name) => name.startsWith("reports-1.0.0")).length >= 2);
  });
});

describe("recoverInterrupted", () => {
  const crashedUpgrade = async (phase: "placing" | "building" | "lifecycle", version = "1.1.0", dist = ".next-crashed") => {
    await apply(await stage());
    const sha = await stage({ version });
    placePackage({
      stagingDir: join(paths().dataDir, "staging", sha),
      moduleId: "reports",
      packageName: "@acme/reports",
      version,
      kind: "upgrade",
      previousVersion: "1.0.0",
      modulesDir: paths().modulesDir,
      nodeModulesDir: join(work, "node_modules"),
      dataDir: paths().dataDir,
      beforeChange: (state) => writeJournal(paths().dataDir, { ...state, version, phase, webRoot: paths().webRoot, dist }),
    });
    // The build the crashed run had made (a finished one when it got as far as the lifecycle, a half one before).
    mkdirSync(join(work, "web", dist), { recursive: true });
    if (phase === "lifecycle") writeFileSync(join(work, "web", dist, "BUILD_ID"), "crashed-run");
    else writeFileSync(join(work, "web", dist, "partial"), "x");
    return sha;
  };
  const recover = () => recoverInterrupted({ pool, ...paths() });
  const moduleVersion = () => JSON.parse(readFileSync(join(work, "modules", "reports", "package.json"), "utf8")).version;

  test("keeps the result when the run died after its database step had completed", async () => {
    await crashedUpgrade("lifecycle");
    await pool.query("update core.modules set installed_version = '1.1.0' where id = 'reports'");
    const notes = await recover();
    assert.match(notes.join("\n"), /kept/);
    assert.match(notes.join("\n"), /put in service/);
    assert.equal(moduleVersion(), "1.1.0");
    assert.equal(readJournal(paths().dataDir), null);
    assert.equal(readLiveDist(join(work, "web"), paths().dataDir).name, ".next-crashed", "the switch the dead run did not get to make is made");
    assert.equal(buildId(), "crashed-run");
  });

  test("keeps the result but does not switch to a build directory that is not a finished build", async () => {
    await crashedUpgrade("building");
    await pool.query("update core.modules set installed_version = '1.1.0' where id = 'reports'");
    writeJournal(paths().dataDir, { ...readJournal(paths().dataDir)!, phase: "lifecycle" });
    const serving = readLiveDist(join(work, "web"), paths().dataDir).name;
    const notes = await recover();
    assert.match(notes.join("\n"), /kept/);
    assert.match(notes.join("\n"), /not a finished build/);
    assert.equal(readLiveDist(join(work, "web"), paths().dataDir).name, serving, "the build that was serving stays the one");
    assert.equal(moduleVersion(), "1.1.0");
  });

  test("undoes the placement when it died in the lifecycle phase before the database moved", async () => {
    await crashedUpgrade("lifecycle");
    const serving = readLiveDist(join(work, "web"), paths().dataDir).name;
    const notes = await recover();
    assert.match(notes.join("\n"), /put back/);
    assert.equal(moduleVersion(), "1.0.0");
    assert.equal(readJournal(paths().dataDir), null);
    assert.equal(existsSync(join(work, "web", ".next-crashed")), false, "the crashed run's build directory is removed");
    assert.equal(readLiveDist(join(work, "web"), paths().dataDir).name, serving, "the build that was serving is still the one");
    assert.equal(existsSync(distRecordPath(paths().dataDir)), true, "the first apply's record is untouched");
  });

  test("undoes a placement that died while placing, before the old folder was moved", async () => {
    await crashedUpgrade("placing");
    await recover();
    assert.equal(moduleVersion(), "1.0.0");
    assert.equal(existsSync(join(paths().dataDir, "previous", "reports-1.0.0")), false);
  });

  test("does nothing while a run with a live process is in progress", async () => {
    await crashedUpgrade("building");
    await startOperation(pool, { moduleId: "reports", version: "1.1.0", sha256: "d".repeat(64), kind: "upgrade", actor: "apply-test" });
    assert.deepEqual(await recover(), []);
    assert.equal(moduleVersion(), "1.1.0", "left as it is for the live run");
    assert.notEqual(readJournal(paths().dataDir), null);
  });

  test("a kept build with no journal is not touched: it may belong to a run of another database that is building right now", async () => {
    const { renameSync } = await import("node:fs");
    renameSync(join(work, "web", ".next"), join(work, "web", ".next.rollback"));
    mkdirSync(join(work, "web", ".next"));
    writeFileSync(join(work, "web", ".next", "in-progress"), "x");
    assert.deepEqual(await recover(), []);
    assert.equal(existsSync(join(work, "web", ".next", "in-progress")), true, "the build in progress is left alone");
    assert.equal(existsSync(join(work, "web", ".next.rollback")), true);
  });
});

