import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type pg from "pg";
import { REGISTRY_FILE } from "../src/codegen/render.ts";
import { generateRegistration } from "../src/codegen/generate.ts";
import { ApplyFailedError, ApplyRefusedError, applyPackage } from "../src/install/apply.ts";
import type { BuildRunner } from "../src/install/build.ts";
import { changeModule } from "../src/install/change.ts";
import { recoverInterrupted } from "../src/install/recover.ts";
import { writeJournal } from "../src/install/journal.ts";
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
  work = mkdtempSync(join(tmpdir(), "modunexo-change-"));
  for (const dir of ["modules", "node_modules", "web"]) mkdirSync(join(work, dir));
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
  builds.length = 0;
  restarts.length = 0;
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

const builds: string[] = [];
const restarts: string[] = [];
const goodBuild: BuildRunner = async (webRoot) => {
  builds.push(readFileSync(join(webRoot, REGISTRY_FILE), "utf8"));
  writeFileSync(join(webRoot, ".next", "BUILD_ID"), `build-${builds.length}`);
  return { code: 0, output: "ok" };
};
const badBuild: BuildRunner = async () => ({ code: 1, output: "Type error: boom" });
const requestRestart = async () => {
  restarts.push("asked");
  return "restart requested";
};

async function install(id = "reports", options: PackageOptions = {}): Promise<void> {
  const file = join(work, `pkg-${id}-${Math.random().toString(36).slice(2)}.tgz`);
  writeFileSync(file, tgz(packageEntries({ id, ...options })));
  const context = await buildPackageContext({ modulesDir: paths().modulesDir, repoRoot: work, pool });
  const taken = await intakePackage({ pool, archive: file, dataDir: paths().dataDir, context, actor: "change-test" });
  assert.equal(taken.ok, true, JSON.stringify(taken));
  await applyPackage({ pool, sha256: createHash("sha256").update(readFileSync(file)).digest("hex"), actor: "change-test", ...paths(), run: goodBuild, requestRestart });
  builds.length = 0;
  restarts.length = 0;
}

const change = (action: "enable" | "disable" | "uninstall", extra: { id?: string; mode?: "keep" | "purge"; run?: BuildRunner; afterPreflight?: () => Promise<void> } = {}) =>
  changeModule({
    pool,
    moduleId: extra.id ?? "reports",
    action,
    ...(extra.mode === undefined ? {} : { mode: extra.mode }),
    ...(extra.afterPreflight === undefined ? {} : { afterPreflight: extra.afterPreflight }),
    actor: "change-test",
    ...paths(),
    run: extra.run ?? goodBuild,
    requestRestart,
  });
const state = async (id = "reports") => (await pool.query("select state from core.modules where id = $1", [id])).rows[0]?.state as string | undefined;
const registryText = () => readFileSync(join(work, "web", REGISTRY_FILE), "utf8");
const schemaExists = async (name: string) => (await pool.query("select 1 from information_schema.schemata where schema_name = $1", [name])).rowCount === 1;

describe("changeModule", () => {
  test("disable builds without the module, then disables it, restarts and records the run", async () => {
    await install();
    assert.match(registryText(), /reports/);
    const result = await change("disable");
    assert.deepEqual({ kind: result.kind, restart: result.restart }, { kind: "disable", restart: "restart requested" });
    assert.equal(await state(), "disabled");
    assert.equal(builds.length, 1);
    assert.doesNotMatch(builds[0]!, /reports/, "the build saw the registry without the module");
    assert.doesNotMatch(registryText(), /reports/);
    assert.equal(restarts.length, 1);
    const [run] = await listOperations(pool, { moduleId: "reports", limit: 1 });
    assert.deepEqual({ kind: run!.kind, status: run!.status, sha256: run!.sha256, actor: run!.actor }, { kind: "disable", status: "succeeded", sha256: null, actor: "change-test" });
    assert.deepEqual(readdirSync(join(work, "web")).filter((name) => name.includes("rollback")), []);
  });

  test("enable builds with the module registered", async () => {
    await install();
    await change("disable");
    builds.length = 0;
    await change("enable");
    assert.equal(await state(), "enabled");
    assert.match(builds[0]!, /reports/);
    assert.match(registryText(), /reports/);
  });

  test("an uninstalled module can be installed again: its folder is kept under var/removed", async () => {
    await install();
    assert.equal(existsSync(join(work, "modules", "reports")), true);
    const result = await change("uninstall", { mode: "keep" });
    assert.equal(existsSync(join(work, "modules", "reports")), false);
    assert.equal(readdirSync(join(work, "var", "removed")).length, 1);
    assert.match(result.warnings.join("\n"), /kept at/);
    await install();
    assert.equal(await state(), "enabled");
    assert.equal(existsSync(join(work, "modules", "reports")), true);
  });

  test("uninstall keep leaves the schema, purge drops it, and neither is in the build", async () => {
    await install("keeper", { files: { "migrations/0001_init.sql": "create table items (id int);\n" } });
    await change("uninstall", { id: "keeper", mode: "keep" });
    assert.equal(await state("keeper"), undefined);
    assert.equal(await schemaExists("keeper"), true);
    assert.doesNotMatch(registryText(), /keeper/);

    await install("purged", { files: { "migrations/0001_init.sql": "create table items (id int);\n" } });
    assert.equal(await schemaExists("purged"), true);
    await change("uninstall", { id: "purged", mode: "purge" });
    assert.equal(await schemaExists("purged"), false);
  });

  test("uninstall purge removes the module's stored files, rows and bytes; keep leaves them", async () => {
    const stored = [["keeper", "11111111-1111-4111-8111-111111111111"], ["purged", "22222222-2222-4222-8222-222222222222"]] as const;
    for (const [id, file] of stored) {
      await install(id);
      mkdirSync(join(work, "var", "files", id, file.slice(0, 2)), { recursive: true });
      writeFileSync(join(work, "var", "files", id, file.slice(0, 2), file), "stored bytes");
      await pool.query("insert into core.files (id, module_id, name, content_type, size, sha256) values ($1, $2, 'a.txt', 'text/plain', 12, $3)", [file, id, "0".repeat(64)]);
    }
    await change("uninstall", { id: "keeper", mode: "keep" });
    assert.equal(existsSync(join(work, "var", "files", "keeper")), true);
    assert.equal((await pool.query("select 1 from core.files where module_id = 'keeper'")).rowCount, 1);

    const result = await change("uninstall", { id: "purged", mode: "purge" });
    assert.equal(existsSync(join(work, "var", "files", "purged")), false);
    assert.equal(existsSync(join(work, "var", "files", "keeper")), true, "another module's bytes stay");
    assert.equal((await pool.query("select 1 from core.files where module_id = 'purged'")).rowCount, 0);
    assert.deepEqual(result.warnings.filter((w) => /files/.test(w)), []);
  });

  test("a build that fails changes nothing and restores the previous build", async () => {
    await install();
    const before = readFileSync(join(work, "web", ".next", "BUILD_ID"), "utf8");
    await assert.rejects(change("disable", { run: badBuild }), (error) => error instanceof ApplyFailedError && error.step === "build");
    assert.equal(await state(), "enabled");
    assert.equal(readFileSync(join(work, "web", ".next", "BUILD_ID"), "utf8"), before);
    assert.match(registryText(), /reports/);
    assert.equal(restarts.length, 0);
    const [run] = await listOperations(pool, { moduleId: "reports", limit: 1 });
    assert.equal(run!.status, "rolled_back");
  });

  test("a hook that fails after the build restores the build and the registration", async () => {
    await install("hooked", { manifest: { hooks: "./hooks.ts" }, files: { "hooks.ts": "export function onDisable() { throw new Error('refuses to stop'); }\n" } });
    const before = readFileSync(join(work, "web", ".next", "BUILD_ID"), "utf8");
    await assert.rejects(change("disable", { id: "hooked" }), (error) => error instanceof ApplyFailedError && error.step === "lifecycle");
    assert.equal(await state("hooked"), "enabled");
    assert.equal(readFileSync(join(work, "web", ".next", "BUILD_ID"), "utf8"), before);
    assert.match(registryText(), /hooked/);
    assert.equal(restarts.length, 0);
  });

  test("a refused action changes nothing and records no run", async () => {
    await install();
    await assert.rejects(change("enable"), (error) => error instanceof ApplyRefusedError && /already enabled/.test(error.message));
    await assert.rejects(change("uninstall"), (error) => error instanceof ApplyRefusedError && /explicit mode/.test(error.message));
    await assert.rejects(change("disable", { id: "ghost" }), ApplyRefusedError);
    assert.equal(builds.length, 0);
    assert.equal((await listOperations(pool, { moduleId: "reports" })).filter((run) => run.kind !== "install").length, 0);
  });

  test("a module that others depend on cannot be disabled or uninstalled", async () => {
    await install("base");
    await install("addon", { manifest: { dependsOn: { base: "^1.0.0" } } });
    await assert.rejects(change("disable", { id: "base" }), (error) => error instanceof ApplyRefusedError && /depend/.test(error.message));
    await assert.rejects(change("uninstall", { id: "base", mode: "keep" }), ApplyRefusedError);
    assert.equal(await state("base"), "enabled");
  });

  test("while another run is alive it is refused and touches nothing", async () => {
    await install();
    await startOperation(pool, { moduleId: "other", version: "1.0.0", sha256: "b".repeat(64), kind: "install", actor: "change-test" });
    await assert.rejects(change("disable"), (error) => error instanceof ApplyRefusedError && /another operation/.test(error.message));
    assert.equal(await state(), "enabled");
    assert.equal(builds.length, 0);
  });

  test("the state is read again once the run holds the lock: a change that went stale is refused, nothing is built", async () => {
    await install();
    // Between the first look and the lock, somebody else disables the module.
    const stale = change("disable", { afterPreflight: async () => void (await pool.query("update core.modules set state = 'disabled' where id = 'reports'")) });
    await assert.rejects(stale, (error) => error instanceof ApplyRefusedError && /already disabled/.test(error.message));
    assert.equal(builds.length, 0);
    const [run] = await listOperations(pool, { moduleId: "reports", limit: 1 });
    assert.equal(run!.status, "failed", "the run that took the lock is closed, not left running");
    assert.match(run!.detail ?? "", /already disabled/);
  });

  test("a stop signal during the build rolls back", async () => {
    await install();
    const slow: BuildRunner = (_root, signal) =>
      new Promise((resolve) => {
        signal?.addEventListener("abort", () => resolve({ code: 130, output: "interrupted" }));
        setTimeout(() => process.emit("SIGINT"), 50);
      });
    await assert.rejects(change("disable", { run: slow }), (error) => error instanceof ApplyFailedError && /interrupt/i.test(error.message));
    assert.equal(await state(), "enabled");
    const [run] = await listOperations(pool, { moduleId: "reports", limit: 1 });
    assert.equal(run!.status, "rolled_back");
  });
});

describe("recovery of a change", () => {
  const crash = async (phase: "building" | "lifecycle", expected: "enabled" | "disabled" | "gone") => {
    await install();
    const { renameSync } = await import("node:fs");
    writeJournal(paths().dataDir, { type: "change", moduleId: "reports", action: "disable", expected, version: "1.0.0", phase, webRoot: paths().webRoot });
    renameSync(join(work, "web", ".next"), join(work, "web", ".next.rollback"));
    mkdirSync(join(work, "web", ".next"));
    writeFileSync(join(work, "web", ".next", "partial"), "x");
  };

  test("a run killed during the build is undone: the previous build comes back", async () => {
    await crash("building", "disabled");
    const notes = await recoverInterrupted({ pool, ...paths() });
    assert.match(notes.join("\n"), /put back/);
    assert.equal(existsSync(join(work, "web", ".next", "partial")), false);
    assert.equal(existsSync(join(work, "web", ".next.rollback")), false);
    assert.equal(await state(), "enabled");
  });

  test("a run killed after its database step completed keeps the result", async () => {
    await crash("lifecycle", "disabled");
    await pool.query("update core.modules set state = 'disabled' where id = 'reports'");
    const notes = await recoverInterrupted({ pool, ...paths() });
    assert.match(notes.join("\n"), /kept/);
    assert.equal(existsSync(join(work, "web", ".next.rollback")), false);
    assert.equal(await state(), "disabled");
  });

  test("a run killed in the lifecycle phase before the database moved is undone", async () => {
    await crash("lifecycle", "disabled");
    const notes = await recoverInterrupted({ pool, ...paths() });
    assert.match(notes.join("\n"), /put back/);
    assert.equal(await state(), "enabled");
  });
});
