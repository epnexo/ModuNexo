import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SDK_VERSION } from "@epnexo/sdk";
import { afterEach, beforeEach, describe, it } from "node:test";
import type pg from "pg";
import { REGISTRY_FILE } from "../src/codegen/render.ts";
import { generateRegistration } from "../src/codegen/generate.ts";
import { ApplyFailedError, ApplyRefusedError, applyPackage } from "../src/install/apply.ts";
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
  work = mkdtempSync(join(tmpdir(), "epnexo-apply-"));
  mkdirSync(join(work, "modules"));
  mkdirSync(join(work, "node_modules"));
  mkdirSync(join(work, "web"));
  generateRegistration([], { outDir: join(work, "web") });
  mkdirSync(join(work, "web", ".next"));
  writeFileSync(join(work, "web", ".next", "BUILD_ID"), "old");
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
const goodBuild: BuildRunner = async (webRoot) => {
  builds.push(readFileSync(join(webRoot, REGISTRY_FILE), "utf8"));
  writeFileSync(join(webRoot, ".next", "BUILD_ID"), "new");
  return { code: 0, output: "ok" };
};
const badBuild: BuildRunner = async () => ({ code: 1, output: "Type error: boom" });
beforeEach(() => {
  builds.length = 0;
});

const restarts: string[] = [];
const requestRestart = async () => {
  restarts.push("asked");
  return "restart requested";
};
beforeEach(() => {
  restarts.length = 0;
});

const apply = (sha256: string, run: BuildRunner = goodBuild) => applyPackage({ pool, sha256, actor: "apply-test", ...paths(), run, requestRestart });
const modulesRows = async () => (await pool.query("select id, state, installed_version from core.modules order by id")).rows;
const buildId = () => readFileSync(join(work, "web", ".next", "BUILD_ID"), "utf8");
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
