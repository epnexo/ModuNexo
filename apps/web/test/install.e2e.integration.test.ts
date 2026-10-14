// End to end for the install pipeline: a module is packed, brought in, applied with a real `next build` while the
// production server runs, and the server restarts into it; then upgraded; then an upgrade whose build fails is
// rolled back and the previous version keeps being served. It runs the real build three times (minutes) against a
// scratch database, and takes the web build lock so it does not collide with the other end-to-end file.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { createAdministrator, createAuth, setSignInMode } from "@epnexo/core/auth";
import { ApplyFailedError, applyPackage, requestRestart } from "@epnexo/core/install";
import { buildPackageContext, intakePackage, packFolder } from "@epnexo/core/packages";
import { createPool } from "@epnexo/core/pool";
import { Registry, migrate } from "@epnexo/core";
import { createScratchDatabase } from "@epnexo/core/testing";
import type pg from "pg";
import { acquireWebLock } from "./helpers/web-lock.ts";

const MASTER_KEY = "i".repeat(40);
const WEB_ROOT = fileURLToPath(new URL("../", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const CLI = join(REPO_ROOT, "packages/core/src/cli/index.ts");
const MODULE_ID = "apply-fixture";
const PACKAGE = "@applyfix/fixture";

let db: pg.Pool | undefined;
let drop: (() => Promise<void>) | undefined;
let skipReason: string | undefined;
let release: (() => void) | undefined;
let server: ChildProcess | undefined;
let work = "";
let dataDir = "";
let port = 0;
let appEnv: Record<string, string> = {};

const childEnv = (extra: Record<string, string>) => ({ ...process.env, ...extra }) as unknown as NodeJS.ProcessEnv;
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port: chosen } = probe.address() as { port: number };
      probe.close(() => resolve(chosen));
    });
  });

const runNode = (args: string[]) =>
  new Promise<{ code: number | null; output: string }>((resolve) => {
    const child = spawn(process.execPath, args, { cwd: REPO_ROOT, env: childEnv(appEnv) });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("exit", (code) => resolve({ code, output }));
  });

async function startLauncher(): Promise<void> {
  let output = "";
  const child = spawn(process.execPath, ["--import", "tsx", `${WEB_ROOT}scripts/run.ts`, "start"], { cwd: REPO_ROOT, env: childEnv(appEnv), detached: true });
  server = child;
  child.stdout?.on("data", (chunk) => (output += chunk));
  child.stderr?.on("data", (chunk) => (output += chunk));
  const deadline = Date.now() + 60_000;
  while (!output.includes("listening on")) {
    if (Date.now() > deadline || child.exitCode !== null) assert.fail(`server did not start:\n${output.slice(-2000)}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const pageText = async (path: string): Promise<string | null> => {
  try {
    const reply = await fetch(`http://127.0.0.1:${port}${path}`, { redirect: "manual" });
    return reply.status === 200 ? (await reply.text()).replace(/<!-- -->/g, "") : null;
  } catch {
    return null;
  }
};
async function waitForPage(path: string, marker: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: string | null = null;
  while (Date.now() < deadline) {
    last = await pageText(path);
    if (last?.includes(marker)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.fail(`${path} never showed "${marker}" (last: ${last === null ? "no 200 reply" : last.slice(0, 200)})`);
}

/** A module folder as its author has it. */
function writeModule(version: string, pageSource: string): string {
  const folder = join(work, `src-${version}`);
  mkdirSync(join(folder, "migrations"), { recursive: true });
  mkdirSync(join(folder, "web"), { recursive: true });
  writeFileSync(join(folder, "package.json"), JSON.stringify({ name: PACKAGE, version, private: true, type: "module" }));
  writeFileSync(
    join(folder, "manifest.ts"),
    `import { SDK_VERSION, defineModule } from "@epnexo/sdk";
export default defineModule({
  id: "${MODULE_ID}",
  version: "${version}",
  name: "Apply Fixture",
  platform: \`^\${SDK_VERSION}\`,
  dependsOn: {},
  schema: "apply_fixture",
  migrationsDir: "migrations",
  nav: [{ label: "Apply fixture", href: "/${MODULE_ID}" }],
  pages: [{ path: "/${MODULE_ID}", entry: "./web/page.tsx", kind: "page" }],
});
`,
  );
  writeFileSync(join(folder, "migrations", "0001_init.sql"), "create table items (id int);\n");
  writeFileSync(join(folder, "web", "page.tsx"), pageSource);
  return folder;
}
const pageWith = (marker: string) => `export const metadata = { title: "Apply fixture" };\nexport default function Page() {\n  return <h1>${marker}</h1>;\n}\n`;

/** pack -> add, as the owner would do on the command line, and returns the SHA-256 to apply. */
async function bringIn(folder: string): Promise<string> {
  const context = await buildPackageContext({ modulesDir: join(REPO_ROOT, "modules"), pool: db! });
  const packed = await packFolder(folder, context, join(work, `${folder.split("/").pop()}.tgz`));
  const taken = await intakePackage({ pool: db!, archive: packed.outFile, dataDir, context, actor: "e2e" });
  assert.equal(taken.ok, true, JSON.stringify(taken));
  return packed.sha256;
}

const applyReal = async (sha256: string) => {
  // The build is a child of this process and inherits its environment.
  Object.assign(process.env, appEnv);
  return applyPackage({ pool: db!, sha256, actor: "e2e", dataDir, requestRestart: () => requestRestart({ dataDir }) });
};

before(async () => {
  release = await acquireWebLock();
  const scratch = await createScratchDatabase();
  if (scratch.url === undefined) {
    skipReason = scratch.skipReason;
    return;
  }
  drop = scratch.drop;
  db = createPool(scratch.url);
  const registry = new Registry();
  registry.registerCore();
  await migrate(db, registry);
  await createAdministrator(createAuth({ pool: db, masterKey: MASTER_KEY, baseURL: "http://localhost", validateSchema: false }), { email: "i@example.test", name: "I", password: "correct horse battery" });
  await setSignInMode(db, "disabled", "e2e");

  // Inside the repository (var/ is not tracked) so the author's manifest.ts can resolve @epnexo/sdk, as it would
  // from a project that has the SDK installed: packing evaluates the manifest where the author works.
  mkdirSync(join(REPO_ROOT, "var"), { recursive: true });
  work = mkdtempSync(join(REPO_ROOT, "var", "install-e2e-"));
  dataDir = join(work, "var");
  port = await freePort();
  appEnv = { DATABASE_URL: scratch.url, EPNEXO_MASTER_KEY: MASTER_KEY, WEB_HOST: "127.0.0.1", WEB_PORT: String(port), NODE_ENV: "production", EPNEXO_DATA_DIR: dataDir };

  // A clean starting point: an empty registry, built, served.
  const generated = await runNode(["--import", "tsx", CLI, "registry:generate"]);
  assert.equal(generated.code, 0, generated.output);
  const built = await runNode(["--import", "tsx", `${WEB_ROOT}scripts/run.ts`, "build"]);
  assert.equal(built.code, 0, `build failed:\n${built.output.slice(-2000)}`);
  await startLauncher();
});

after(async () => {
  if (server?.pid !== undefined && server.exitCode === null) {
    try {
      process.kill(-server.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  if (db !== undefined) {
    await runNode(["--import", "tsx", CLI, "modules", "uninstall", MODULE_ID, "--purge"]).catch(() => undefined);
    rmSync(join(REPO_ROOT, "modules", MODULE_ID), { recursive: true, force: true });
    rmSync(join(REPO_ROOT, "node_modules", "@applyfix"), { recursive: true, force: true });
    await runNode(["--import", "tsx", CLI, "registry:generate"]).catch(() => undefined);
  }
  await db?.end();
  await drop?.();
  if (work !== "") rmSync(work, { recursive: true, force: true });
  release?.();
});

describe("install pipeline: end to end", () => {
  const test = (name: string, run: () => Promise<void>) =>
    it(name, { timeout: 600_000 }, async (t) => {
      if (db === undefined) return t.skip(skipReason);
      await run();
    });

  test("installs a module into the running server, which restarts and serves it", async () => {
    assert.equal(await pageText(`/${MODULE_ID}`), null, "the module is not served before");
    const sha = await bringIn(writeModule("1.0.0", pageWith("apply-marker-v1")));
    const result = await applyReal(sha);
    assert.equal(result.kind, "install");
    assert.match(result.restart, /restart requested/);
    await waitForPage(`/${MODULE_ID}`, "apply-marker-v1");
    assert.deepEqual((await db!.query("select id, state, installed_version from core.modules")).rows, [{ id: MODULE_ID, state: "enabled", installed_version: "1.0.0" }]);
    assert.ok(existsSync(join(REPO_ROOT, "modules", MODULE_ID, "manifest.ts")));
  });

  test("upgrades it, keeping the previous version aside", async () => {
    const sha = await bringIn(writeModule("1.1.0", pageWith("apply-marker-v2")));
    const result = await applyReal(sha);
    assert.equal(result.kind, "upgrade");
    await waitForPage(`/${MODULE_ID}`, "apply-marker-v2");
    assert.ok(existsSync(join(dataDir, "previous", `${MODULE_ID}-1.0.0`, "package.json")));
  });

  test("an upgrade whose real build fails is rolled back and the previous version keeps being served", async () => {
    const sha = await bringIn(writeModule("1.2.0", "export default function Page() { return <h1>broken; }\n"));
    await assert.rejects(applyReal(sha), (error) => {
      assert.ok(error instanceof ApplyFailedError);
      assert.equal(error.step, "build");
      return true;
    });
    assert.equal(JSON.parse(readFileSync(join(REPO_ROOT, "modules", MODULE_ID, "package.json"), "utf8")).version, "1.1.0");
    assert.deepEqual((await db!.query("select installed_version from core.modules")).rows, [{ installed_version: "1.1.0" }]);
    assert.deepEqual(readdirSync(WEB_ROOT).filter((name) => name.includes("rollback")), []);
    await waitForPage(`/${MODULE_ID}`, "apply-marker-v2", 30_000);
    const [last] = (await db!.query("select status, step from core.module_operations order by id desc limit 1")).rows;
    assert.deepEqual(last, { status: "rolled_back", step: "build" });
  });
});

describe("Apps screen API: upload, confirm, follow the run", () => {
  const api = (method: string, path: string, init: { body?: BodyInit; headers?: Record<string, string> } = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { origin: `http://127.0.0.1:${port}`, ...init.headers },
      ...(init.body === undefined ? {} : { body: init.body }),
    });
  const test = (name: string, run: () => Promise<void>) =>
    it(name, { timeout: 900_000 }, async (t) => {
      if (db === undefined) return t.skip(skipReason);
      await run();
    });

  test("refuses another site and a body that is not a package, and lists the runs", async () => {
    const cross = await fetch(`http://127.0.0.1:${port}/api/apps/packages`, { method: "POST", headers: { origin: "http://evil.example" }, body: "x" });
    assert.equal(cross.status, 403);
    const garbage = await api("POST", "/api/apps/packages", { body: "this is not an archive", headers: { "content-type": "application/gzip" } });
    assert.equal(garbage.status, 422);
    assert.ok(Array.isArray(((await garbage.json()) as { problems: unknown[] }).problems));
    const state = await api("GET", "/api/apps");
    assert.equal(state.status, 200);
    const body = (await state.json()) as { operations: { status: string }[]; running: unknown };
    assert.ok(body.operations.length >= 3, "the earlier runs are listed");
    assert.equal(body.running, null);
  });

  test("uploads a package, confirms it, and the run goes through to the restarted server", async () => {
    const context = await buildPackageContext({ modulesDir: join(REPO_ROOT, "modules"), pool: db! });
    const packed = await packFolder(writeModule("1.3.0", pageWith("apply-marker-v3")), context, join(work, "ui-1.3.0.tgz"));
    const upload = await api("POST", "/api/apps/packages", { body: readFileSync(packed.outFile), headers: { "content-type": "application/gzip", "x-expected-sha256": packed.sha256 } });
    assert.equal(upload.status, 200, await upload.clone().text());
    const staged = (await upload.json()) as { status: string; sha256: string; review: { id: string; version: string } };
    assert.deepEqual({ status: staged.status, sha256: staged.sha256, id: staged.review.id, version: staged.review.version }, { status: "staged", sha256: packed.sha256, id: MODULE_ID, version: "1.3.0" });
    assert.equal((await db!.query("select 1 from core.modules where installed_version = '1.3.0'")).rowCount, 0, "uploading installs nothing");

    const start = await api("POST", "/api/apps/operations", { body: JSON.stringify({ sha256: packed.sha256 }), headers: { "content-type": "application/json" } });
    assert.equal(start.status, 202, await start.clone().text());

    // While it runs a second start is refused.
    const deadline = Date.now() + 120_000;
    let seen: { operations: { status: string; step: string; actor: string }[]; running: unknown } | undefined;
    while (Date.now() < deadline) {
      const reply = await fetch(`http://127.0.0.1:${port}/api/apps`).catch(() => null);
      if (reply?.ok) {
        seen = (await reply.json()) as typeof seen;
        if (seen?.running !== null) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    assert.notEqual(seen?.running, null, "the run showed up as running");
    const second = await api("POST", "/api/apps/operations", { body: JSON.stringify({ sha256: packed.sha256 }), headers: { "content-type": "application/json" } });
    assert.equal(second.status, 409);

    try {
      await waitForPage(`/${MODULE_ID}`, "apply-marker-v3", 420_000);
    } catch (error) {
      // Say what the run did, not only that the page never changed.
      const [last] = (await db!.query("select status, step, detail from core.module_operations order by id desc limit 1")).rows;
      const logs = join(dataDir, "logs");
      const tail = existsSync(logs) ? readdirSync(logs).sort().slice(-1).map((name) => readFileSync(join(logs, name), "utf8").slice(-1500)).join("") : "(no log)";
      assert.fail(`${error instanceof Error ? error.message : String(error)}\nlast run: ${JSON.stringify(last)}\napply log:\n${tail}`);
    }
    const final = await api("GET", "/api/apps");
    const body = (await final.json()) as { operations: { status: string; actor: string; version: string }[]; running: unknown };
    assert.equal(body.operations[0]!.status, "succeeded");
    assert.equal(body.operations[0]!.version, "1.3.0");
    assert.equal(body.operations[0]!.actor, "local-operator", "the run is recorded as who asked for it");
    assert.deepEqual((await db!.query("select installed_version from core.modules")).rows, [{ installed_version: "1.3.0" }]);
  });

  test("the Apps page shows the add-a-package flow to an administrator", async () => {
    const page = await pageText("/apps");
    assert.ok(page !== null && page.includes("Add a package"), page?.slice(0, 300));
    assert.ok(page.includes("History"));
  });
});
