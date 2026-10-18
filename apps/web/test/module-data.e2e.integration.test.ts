// End to end for module data access: a module made by `modules new` is packed, brought in and applied with a real
// `next build`; its page lists and adds rows through getDb (a form posted to its server action). A second module that
// lists the first in dependsOn reads the first one's rows through `reader` and cannot write to them. It runs the real
// build twice (minutes) against a scratch database and takes the web build lock, like the other end-to-end file.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { BrandService } from "@epnexo/core/settings";
import { createAdministrator, createAuth, setSignInMode } from "@epnexo/core/auth";
import { applyPackage, requestRestart } from "@epnexo/core/install";
import { buildPackageContext, intakePackage, packFolder } from "@epnexo/core/packages";
import { createPool } from "@epnexo/core/pool";
import { scaffoldModule } from "@epnexo/core/scaffold";
import { Registry, migrate } from "@epnexo/core";
import { createScratchDatabase } from "@epnexo/core/testing";
import type pg from "pg";
import { acquireWebLock } from "./helpers/web-lock.ts";

const MASTER_KEY = "d".repeat(40);
const WEB_ROOT = fileURLToPath(new URL("../", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const CLI = join(REPO_ROOT, "packages/core/src/cli/index.ts");
const NOTES = "e2e-notes";
const READER = "e2e-reader";

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

const url = (path: string) => `http://127.0.0.1:${port}${path}`;
const pageText = async (path: string): Promise<string | null> => {
  try {
    const reply = await fetch(url(path), { redirect: "manual" });
    return reply.status === 200 ? (await reply.text()).replace(/<!-- -->/g, "") : null;
  } catch {
    return null;
  }
};
async function waitForPage(path: string, marker: string, timeoutMs = 90_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last: string | null = null;
  while (Date.now() < deadline) {
    last = await pageText(path);
    if (last?.includes(marker)) return last;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return assert.fail(`${path} never showed "${marker}" (last: ${last === null ? "no 200 reply" : last.slice(0, 300)})`);
}

/** pack -> add, as the owner would do on the command line, and returns the SHA-256 to apply. */
async function bringIn(folder: string): Promise<string> {
  const context = await buildPackageContext({ modulesDir: join(REPO_ROOT, "modules"), pool: db! });
  const packed = await packFolder(folder, context, join(work, `${folder.split("/").pop()}.tgz`));
  const taken = await intakePackage({ pool: db!, archive: packed.outFile, dataDir, context, actor: "e2e" });
  assert.equal(taken.ok, true, JSON.stringify(taken));
  return packed.sha256;
}

const applyReal = async (sha256: string) => {
  Object.assign(process.env, appEnv);
  return applyPackage({ pool: db!, sha256, actor: "e2e", dataDir, requestRestart: () => requestRestart({ dataDir }) });
};

/** A second module that reads the first one's rows and tries to write to them. */
function writeReaderModule(): string {
  const folder = join(work, READER);
  mkdirSync(join(folder, "migrations"), { recursive: true });
  mkdirSync(join(folder, "web"), { recursive: true });
  writeFileSync(join(folder, "package.json"), JSON.stringify({ name: `@local/${READER}`, version: "0.1.0", private: true, type: "module" }));
  writeFileSync(
    join(folder, "manifest.ts"),
    `import { SDK_VERSION, defineModule } from "@epnexo/sdk";
export default defineModule({
  id: "${READER}",
  version: "0.1.0",
  name: "E2E Reader",
  platform: \`^\${SDK_VERSION}\`,
  dependsOn: { "${NOTES}": "^0.1.0" },
  schema: "e2e_reader",
  migrationsDir: "migrations",
  nav: [{ label: "E2E Reader", href: "/${READER}" }],
  pages: [{ path: "/${READER}", entry: "./web/page.tsx", kind: "page", dynamic: "force-dynamic" }],
});
`,
  );
  writeFileSync(join(folder, "migrations", "0001_init.sql"), "create table marks (id int);\n");
  writeFileSync(
    join(folder, "web", "page.tsx"),
    `import { getDb } from "@epnexo/sdk";

export const metadata = { title: "E2E Reader" };

export default async function Page() {
  const notes = getDb("${READER}").reader("${NOTES}");
  const seen = await notes.query<{ title: string }>("select title from items order by id");
  let write = "allowed";
  try {
    await notes.query("insert into items (title) values ('smuggled')");
  } catch (error) {
    write = "refused " + String((error as { code?: string }).code);
  }
  return (
    <div>
      <h1>reader-marker</h1>
      <p>{"rows:" + seen.rows.map((row) => row.title).join("|")}</p>
      <p>{"write:" + write}</p>
    </div>
  );
}
`,
  );
  return folder;
}

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
  await createAdministrator(createAuth({ pool: db, masterKey: MASTER_KEY, baseURL: "http://localhost", validateSchema: false }), { email: "d@example.test", name: "D", password: "correct horse battery" });
  await setSignInMode(db, "disabled", "e2e");
  await new BrandService(db).setProfile({ kind: "personal", name: "E2E" }, "e2e");

  // Inside the repository (var/ is not tracked) so the author's manifest.ts can resolve @epnexo/sdk.
  mkdirSync(join(REPO_ROOT, "var"), { recursive: true });
  work = mkdtempSync(join(REPO_ROOT, "var", "data-e2e-"));
  dataDir = join(work, "var");
  port = await freePort();
  appEnv = { DATABASE_URL: scratch.url, EPNEXO_MASTER_KEY: MASTER_KEY, WEB_HOST: "127.0.0.1", WEB_PORT: String(port), NODE_ENV: "production", EPNEXO_DATA_DIR: dataDir };

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
    for (const id of [READER, NOTES]) {
      await runNode(["--import", "tsx", CLI, "modules", "uninstall", id, "--purge"]).catch(() => undefined);
      rmSync(join(REPO_ROOT, "modules", id), { recursive: true, force: true });
      rmSync(join(REPO_ROOT, "node_modules", "@local", id), { recursive: true, force: true });
    }
    await runNode(["--import", "tsx", CLI, "registry:generate"]).catch(() => undefined);
  }
  await db?.end();
  await drop?.();
  if (work !== "") rmSync(work, { recursive: true, force: true });
  release?.();
});

describe("module data access: end to end", () => {
  const test = (name: string, run: () => Promise<void>) =>
    it(name, { timeout: 900_000 }, async (t) => {
      if (db === undefined) return t.skip(skipReason);
      await run();
    });

  test("a generated module is installed, lists rows and adds one through its server action", async () => {
    const { folder } = await scaffoldModule({ id: NOTES, name: "E2E Notes", parentDir: work });
    const result = await applyReal(await bringIn(folder));
    assert.equal(result.kind, "install");
    const html = await waitForPage(`/${NOTES}`, "Nothing here yet.");

    // Progressive enhancement: a plain multipart form post carrying the hidden action id, as a browser without JS sends.
    const action = /name="(\$ACTION_ID_[0-9a-f]+)"/.exec(html)?.[1];
    assert.ok(action, "the form carries a server action id");
    const form = new FormData();
    form.set(action, "");
    form.set("title", "first note");
    const reply = await fetch(url(`/${NOTES}`), { method: "POST", body: form, headers: { origin: url("") }, redirect: "manual" });
    assert.ok(reply.status < 400, `the action replied ${reply.status}`);
    await waitForPage(`/${NOTES}`, "first note");
    assert.deepEqual((await db!.query(`select title from e2e_notes.items`)).rows, [{ title: "first note" }]);
  });

  test("a module that depends on it reads those rows, and a write through the reader is refused by the database", async () => {
    const result = await applyReal(await bringIn(writeReaderModule()));
    assert.equal(result.kind, "install");
    const html = await waitForPage(`/${READER}`, "reader-marker");
    assert.match(html, /rows:first note/);
    assert.match(html, /write:refused 25006/);
    assert.deepEqual((await db!.query(`select title from e2e_notes.items`)).rows, [{ title: "first note" }], "nothing was smuggled in");
  });
});
