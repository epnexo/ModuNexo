// End to end: the production build, served by the platform's own server, against a scratch database. This is the
// proof that the gate, the stamped connection address and the cookies behave on real requests; the pure pieces are
// tested on their own in the other files. It builds the app (several seconds) and is skipped when no test database
// is reachable.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { createAdministrator, createAuth, setSignInMode, setTrustedProxies } from "@modunexo/core/auth";
import { BrandService } from "@modunexo/core/settings";
import { createPool } from "@modunexo/core/pool";
import { Registry, migrate } from "@modunexo/core";
import { createScratchDatabase } from "@modunexo/core/testing";
import type pg from "pg";
import { acquireWebLock } from "./helpers/web-lock.ts";

const MASTER_KEY = "e".repeat(40);
const EMAIL = "e2e@example.test";
const PASSWORD = "correct horse battery";
const WEB_ROOT = fileURLToPath(new URL("../", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

let db: pg.Pool | undefined;
let drop: (() => Promise<void>) | undefined;
let skipReason: string | undefined;
let server: ChildProcess | undefined;
let serverOutput = "";
let port = 0;
let scratchUrl = "";

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port: chosen } = probe.address() as { port: number };
      probe.close(() => resolve(chosen));
    });
  });

/** The environment of a child: ours plus the given variables. Next's types make NODE_ENV a closed union, hence the cast. */
const childEnv = (extra: Record<string, string>) => ({ ...process.env, ...extra }) as unknown as NodeJS.ProcessEnv;

const run = (args: string[], env: Record<string, string>) =>
  new Promise<{ code: number | null; output: string }>((resolve) => {
    const child = spawn(process.execPath, args, { cwd: REPO_ROOT, env: childEnv(env) });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("exit", (code) => resolve({ code, output }));
  });

/** One request with whatever headers the case needs, including Host, which fetch would not let us set. */
const call = (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) =>
  new Promise<Reply>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest(
      { host: "127.0.0.1", port, method, path, headers: { ...(payload === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }), ...headers } },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });

/** A request with a raw body: bytes or text, sent as they are. */
const callRaw = (method: string, path: string, headers: Record<string, string>, body: string | Buffer) =>
  new Promise<Reply>((resolve, reject) => {
    const payload = typeof body === "string" ? Buffer.from(body) : body;
    const req = httpRequest({ host: "127.0.0.1", port, method, path, headers: { "content-type": "application/octet-stream", "content-length": payload.length, ...headers } }, (res) => {
      let text = "";
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.on("error", reject);
    req.end(payload);
  });

const origin = () => `http://127.0.0.1:${port}`;
const signIn = (password: string, extra: Record<string, string> = {}) =>
  call("POST", "/api/auth/sign-in/email", { origin: origin(), ...extra }, { email: EMAIL, password });
const cookieOf = (reply: Reply) => {
  const lines = ([] as string[]).concat(reply.headers["set-cookie"] ?? []);
  return lines.map((line) => line.split(";")[0]).join("; ");
};
const location = (reply: Reply) => (reply.headers.location === undefined ? "" : new URL(String(reply.headers.location), origin()).pathname);

let appEnv: Record<string, string> = {};
/** Where the app, the worker and the CLI keep stored files in these tests, so nothing lands in the repository's var/. */
let dataDir = "";

async function buildApp(): Promise<void> {
  const built = await run(["--import", "tsx", `${WEB_ROOT}scripts/run.ts`, "build"], appEnv);
  assert.equal(built.code, 0, `build failed:\n${built.output.slice(-2000)}`);
}

async function startServer(): Promise<void> {
  serverOutput = "";
  const child = spawn(process.execPath, ["--import", "tsx", `${WEB_ROOT}scripts/run.ts`, "start"], { cwd: REPO_ROOT, env: childEnv(appEnv), detached: true });
  server = child;
  child.stdout?.on("data", (chunk) => (serverOutput += chunk));
  child.stderr?.on("data", (chunk) => (serverOutput += chunk));
  const deadline = Date.now() + 60_000;
  while (!serverOutput.includes("listening on")) {
    if (Date.now() > deadline || child.exitCode !== null) assert.fail(`server did not start:\n${serverOutput.slice(-2000)}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** Sends SIGTERM to the server's process group and waits for it to exit. Returns the exit code and how long it took. */
async function stopServer(): Promise<{ code: number | null | "timeout"; ms: number }> {
  const child = server;
  if (child?.pid === undefined || child.exitCode !== null) return { code: child?.exitCode ?? null, ms: 0 };
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  const started = Date.now();
  process.kill(-child.pid, "SIGTERM");
  const code = await Promise.race([exited, new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 12_000))]);
  return { code, ms: Date.now() - started };
}

let releaseWebLock: (() => void) | undefined;

before(async () => {
  releaseWebLock = await acquireWebLock();
  const scratch = await createScratchDatabase();
  if (scratch.url === undefined) {
    skipReason = scratch.skipReason;
    return;
  }
  scratchUrl = scratch.url;
  drop = scratch.drop;
  db = createPool(scratchUrl);
  const registry = new Registry();
  registry.registerCore();
  await migrate(db, registry);
  await createAdministrator(createAuth({ pool: db, masterKey: MASTER_KEY, baseURL: "http://localhost", validateSchema: false }), { email: EMAIL, name: "E2E", password: PASSWORD });
  // The shell sends a visitor to /setup until a profile exists, so the pages these tests fetch need one.
  await new BrandService(db).setProfile({ kind: "personal", name: "E2E" }, "e2e");

  port = await freePort();
  dataDir = mkdtempSync(join(tmpdir(), "modunexo-e2e-data-"));
  appEnv = { DATABASE_URL: scratchUrl, MODUNEXO_MASTER_KEY: MASTER_KEY, MODUNEXO_DATA_DIR: dataDir, WEB_HOST: "127.0.0.1", WEB_PORT: String(port), NODE_ENV: "production" };
  await buildApp();
  await startServer();
});

after(async () => {
  if (server?.pid !== undefined && server.exitCode === null) {
    try {
      process.kill(-server.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  removeFixture();
  if (dataDir !== "") rmSync(dataDir, { recursive: true, force: true });
  if (db !== undefined) {
    // The module's routes and registry entry were generated into the working tree; with the module gone from the
    // database and from disk, regenerating leaves the empty registry that a fresh checkout has.
    await run(["--import", "tsx", CLI, "registry:generate"], appEnv).catch(() => undefined);
  }
  await db?.end();
  await drop?.();
  releaseWebLock?.();
});

const test = (name: string, work: () => Promise<void>) =>
  it(name, { timeout: 60_000 }, async (t) => {
    if (db === undefined) return t.skip(skipReason);
    await work();
  });

describe("web app: sign-in required", () => {
  test("sends a visitor without a session to the sign-in page and answers API calls with 401", async () => {
    const root = await call("GET", "/");
    assert.equal(root.status, 307);
    assert.equal(location(root), "/login");
    assert.equal((await call("GET", "/apps")).status, 307);
    const login = await call("GET", "/login");
    assert.equal(login.status, 200);
    assert.doesNotMatch(login.body, /href="\/apps"/, "the sign-in page is shown without the shell around it");
    assert.equal((await call("GET", "/api/modules")).status, 401);
    assert.equal((await call("GET", "/settings")).status, 307);
  });

  test("does not let a path trick past the gate", async () => {
    for (const path of ["/login/../apps", "/%2e%2e/apps", "/APPS", "/apps?x=/login", "/_next/data/x/index.json", "/api/auth%2f..%2fmodules"]) {
      const reply = await call("GET", path);
      assert.ok([307, 308, 401, 404].includes(reply.status), `${path} -> ${reply.status}`);
      assert.doesNotMatch(reply.body, new RegExp(EMAIL));
    }
  });

  test("answers a wrong password and an unknown email the same way, and refuses sign-up", async () => {
    const wrong = await signIn("wrong password here");
    const unknown = await call("POST", "/api/auth/sign-in/email", { origin: origin() }, { email: "nobody@example.test", password: "wrong password here" });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.equal(wrong.body, unknown.body);
    const signUp = await call("POST", "/api/auth/sign-up/email", { origin: origin() }, { email: "m@example.test", name: "M", password: PASSWORD });
    assert.equal(signUp.status, 400);
  });

  test("refuses a sign-in whose Origin is another site", async () => {
    const reply = await signIn(PASSWORD, { origin: "https://evil.example" });
    assert.equal(reply.status, 403);
  });

  test("a session works over plain HTTP, ends at sign-out, and stops when the user is banned", async () => {
    const reply = await signIn(PASSWORD);
    assert.equal(reply.status, 200);
    const setCookie = ([] as string[]).concat(reply.headers["set-cookie"] ?? []).join("\n");
    assert.match(setCookie, /better-auth\.session_token=/);
    assert.doesNotMatch(setCookie, /Secure/i, "a Secure cookie is dropped by a browser on a plain HTTP LAN address");
    assert.doesNotMatch(setCookie, /__Secure-/);
    const cookie = cookieOf(reply);

    const home = await call("GET", "/", { cookie });
    assert.equal(home.status, 200);
    assert.match(home.body, new RegExp(EMAIL));
    assert.match(home.body, /href="\/apps"/, "the sidebar lists the shell's own entries");
    assert.match(home.body, /href="\/settings"/);
    assert.match(home.body, /No modules are installed yet/, "with zero modules the home screen says so");
    assert.match(home.body, /Sign out/);
    const apps = await call("GET", "/apps", { cookie });
    assert.equal(apps.status, 200);
    assert.match(apps.body, /No modules are enabled in this build/);
    assert.equal((await call("GET", "/settings", { cookie })).status, 200);
    assert.equal(location(await call("GET", "/login", { cookie })), "/");

    await db!.query(`update core.auth_user set "banned" = true where "email" = $1`, [EMAIL]);
    assert.equal(location(await call("GET", "/", { cookie })), "/login", "a banned user's session must stop working");
    await db!.query(`update core.auth_user set "banned" = null where "email" = $1`, [EMAIL]);
    assert.equal((await call("GET", "/", { cookie })).status, 200);

    assert.equal((await call("POST", "/api/auth/sign-out", { cookie, origin: origin() }, {})).status, 200);
    assert.equal(location(await call("GET", "/", { cookie })), "/login", "the old cookie must be dead");
  });
});

describe("web app: sign-in disabled", () => {
  before(async () => {
    if (db !== undefined) await setSignInMode(db, "disabled", "test");
  });
  after(async () => {
    if (db !== undefined) await setSignInMode(db, "required", "test");
  });

  test("serves a local request without a session and has no sign-in page", async () => {
    const home = await call("GET", "/");
    assert.equal(home.status, 200);
    assert.match(home.body, /Local operator/, "the top bar says the shell is acting as a local operator");
    assert.doesNotMatch(home.body, /Sign out/, "there is no session to end");
    assert.equal((await call("GET", "/apps")).status, 200);
    assert.equal(location(await call("GET", "/login")), "/");
  });

  test("refuses every request that carries a public address, with a body that says nothing", async () => {
    const cases: Record<string, string>[] = [
      { "x-forwarded-for": "8.8.8.8" },
      { "x-forwarded-for": "8.8.8.8, 192.168.1.5" },
      { "x-forwarded-for": "192.168.1.5, 8.8.8.8" },
      { forwarded: "for=8.8.8.8" },
      { forwarded: 'for="[2001:db8::1]"' },
      { "x-real-ip": "8.8.8.8" },
      { "cf-connecting-ip": "8.8.8.8" },
      { "true-client-ip": "8.8.8.8" },
      { "x-client-ip": "8.8.8.8" },
    ];
    for (const headers of cases) {
      const reply = await call("GET", "/", headers);
      assert.equal(reply.status, 403, JSON.stringify(headers));
      assert.equal(reply.body, "Forbidden");
    }
    assert.equal((await call("GET", "/api/auth/get-session", { "x-forwarded-for": "8.8.8.8" })).status, 403);
  });

  test("refuses a local connection that names a public host: DNS rebinding", async () => {
    for (const host of ["evil.example", `evil.example:${port}`, "modunexo.dev"]) {
      const reply = await call("GET", "/", { host });
      assert.equal(reply.status, 403, host);
      assert.equal(reply.body, "Forbidden");
    }
    assert.equal((await call("GET", "/", { host: `localhost:${port}` })).status, 200);
    assert.equal((await call("GET", "/", { host: `raspberrypi:${port}` })).status, 200);
  });

  test("believes the connection, not a client-written trusted header", async () => {
    assert.equal((await call("GET", "/", { "x-modunexo-client-ip": "8.8.8.8" })).status, 200);
    assert.equal((await call("GET", "/", { "x-modunexo-client-ip": "127.0.0.1", "x-forwarded-for": "8.8.8.8" })).status, 403);
    assert.equal((await call("GET", "/", { "x-forwarded-for": "192.168.1.5" })).status, 200);
  });
});

describe("web app: limits and failure", () => {
  test("a rotating x-forwarded-for does not avoid the sign-in limit", async () => {
    await db!.query("delete from core.auth_rate_limit");
    const seen: number[] = [];
    for (let i = 1; i <= 8; i++) seen.push((await signIn("wrong password here", { "x-forwarded-for": `10.7.7.${i}` })).status);
    assert.deepEqual(seen.slice(0, 5), [401, 401, 401, 401, 401]);
    assert.ok(seen.slice(5).every((status) => status === 429), seen.join(" "));
  });

  test("answers 503, never 200, when the database cannot be read", async () => {
    await db!.query("alter table core.platform_settings rename to platform_settings_away");
    try {
      assert.equal((await call("GET", "/")).status, 503);
      assert.equal((await call("GET", "/login")).status, 503);
    } finally {
      await db!.query("alter table core.platform_settings_away rename to platform_settings");
    }
  });

  test("reads a corrupted mode as required", async () => {
    await db!.query("delete from core.platform_settings");
    await db!.query(`insert into core.platform_settings (key, value, updated_by) values ('auth.signIn', '"off"'::jsonb, 'test')`);
    assert.equal(location(await call("GET", "/")), "/login");
    await db!.query("delete from core.platform_settings");
    // The profile lives in the same table: without it the shell sends everyone to /setup.
    await new BrandService(db!).setProfile({ kind: "personal", name: "E2E" }, "test");
  });

  test("warns once, not once per request, when requests arrive over HTTPS without WEB_PUBLIC_URL", async () => {
    for (let i = 0; i < 6; i++) {
      const reply = await call("GET", "/login", { "x-forwarded-proto": "https" });
      assert.equal(reply.status, 200, "the warning is a hint; it never changes who gets in");
    }
    const lines = serverOutput.split("\n").filter((line) => line.includes("WEB_PUBLIC_URL is not an https origin"));
    assert.equal(lines.length, 1, `expected one warning line, got ${lines.length}`);
  });
});

// --- Phase two: a real module, installed through the CLI and linked the way `npm install` links a workspace ---

const FIXTURE_ID = "e2e-fixture";
const FIXTURE_DIR = join(REPO_ROOT, "modules", FIXTURE_ID);
const FIXTURE_SCOPE_DIR = join(REPO_ROOT, "node_modules", "@e2e");
const CLI = join(REPO_ROOT, "packages/core/src/cli/index.ts");
const TOKEN_PLAIN = "tok_live_e2e_0123456789abcdef";

function removeFixture(): void {
  rmSync(FIXTURE_SCOPE_DIR, { recursive: true, force: true });
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
}

function writeFixture(): void {
  removeFixture();
  mkdirSync(join(FIXTURE_DIR, "migrations"), { recursive: true });
  mkdirSync(join(FIXTURE_DIR, "web"), { recursive: true });
  writeFileSync(join(FIXTURE_DIR, "package.json"), JSON.stringify({ name: "@e2e/fixture", version: "1.0.0", private: true, type: "module" }));
  writeFileSync(
    join(FIXTURE_DIR, "manifest.ts"),
    `import { SDK_VERSION, defineModule } from "@modunexo/sdk";
export default defineModule({
  id: "${FIXTURE_ID}",
  version: "1.0.0",
  name: "E2E Fixture",
  platform: \`^\${SDK_VERSION}\`,
  dependsOn: {},
  schema: "e2e_fixture",
  migrationsDir: "migrations",
  permissions: [{ key: "reports.read", label: "Read reports" }],
  jobs: [
    { name: "record", entry: "./jobs/record.ts", maxAttempts: 2 },
    { name: "emit", entry: "./jobs/emit.ts", maxAttempts: 1 },
    { name: "on_pinged", entry: "./jobs/on_pinged.ts", maxAttempts: 1 },
  ],
  events: [{ name: "pinged", permission: "reports.read" }, { name: "private.note" }],
  subscriptions: [{ event: "${FIXTURE_ID}.pinged", job: "on_pinged" }],
  files: { maxBytes: 2048, accept: ["image/png", "text/plain"], permission: "reports.read" },
  scopes: [
    { key: "messages.read", label: "Read messages" },
    { key: "messages.send", label: "Send messages" },
  ],
  nav: [
    { label: "Fixture", href: "/e2e-fixture", group: "Fixtures", order: 1, icon: "chart" },
    { label: "Restricted", href: "/e2e-fixture/area", group: "Fixtures", order: 2, permission: "reports.read" },
  ],
  pages: [
    { path: "/e2e-fixture", entry: "./web/page.tsx", kind: "page" },
    { path: "/e2e-fixture/restricted", entry: "./web/restricted.tsx", kind: "page", permission: "reports.read" },
    { path: "/e2e-fixture/area/[id]", entry: "./web/area.tsx", kind: "page" },
    { path: "/e2e-fixture/data", entry: "./web/data.ts", kind: "route", permission: "reports.read" },
    { path: "/e2e-fixture/open-data", entry: "./web/open-data.ts", kind: "route" },
    { path: "/e2e-fixture/enqueue", entry: "./web/enqueue.ts", kind: "route", methods: ["POST"], permission: "reports.read" },
    { path: "/e2e-fixture/publish", entry: "./web/publish.ts", kind: "route", methods: ["POST"], permission: "reports.read" },
    { path: "/e2e-fixture/upload", entry: "./web/upload.ts", kind: "route", methods: ["POST"], permission: "reports.read" },
    {
      path: "/hooks/e2e-fixture/events",
      entry: "./web/hook.ts",
      kind: "route",
      methods: ["POST"],
      public: { signature: { secret: "hook.secret", header: "x-signature" } },
    },
    { path: "/svc/e2e-fixture/items", entry: "./web/items.ts", kind: "route", scope: "messages.read" },
    { path: "/svc/e2e-fixture/send", entry: "./web/send.ts", kind: "route", methods: ["POST"], scope: "messages.send" },
  ],
  settings: [
    { key: "site.title", label: "Site title", type: "string", default: "Untitled" },
    { key: "page.size", label: "Page size", type: "number", default: 25 },
    { key: "report.format", label: "Report format", type: "select", options: ["pdf", "csv"], default: "pdf" },
    { key: "export.dir", label: "Export directory", type: "path", required: true },
    { key: "api.token", label: "API token", type: "secret", required: true },
    { key: "hook.secret", label: "Webhook secret", type: "secret" },
  ],
});
`,
  );
  writeFileSync(join(FIXTURE_DIR, "migrations", "0001_init.sql"), "create table items (id int);");
  writeFileSync(
    join(FIXTURE_DIR, "web", "page.tsx"),
    `import { getSetting } from "@modunexo/sdk";
export const metadata = { title: "Fixture" };
export default async function Page() {
  const title = await getSetting("${FIXTURE_ID}", "site.title");
  return (
    <div>
      <h1>Fixture page</h1>
      <p>Title setting: [{String(title)}]</p>
    </div>
  );
}
`,
  );
  writeFileSync(join(FIXTURE_DIR, "web", "restricted.tsx"), `export const metadata = { title: "Restricted" };\nexport default function Page() {\n  return <h1>Restricted page</h1>;\n}\n`);
  writeFileSync(
    join(FIXTURE_DIR, "web", "area.tsx"),
    `export const metadata = { title: "Area" };
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <h1>Area {id}</h1>;
}
`,
  );
  writeFileSync(join(FIXTURE_DIR, "web", "data.ts"), `export async function GET() {\n  return Response.json({ secret: "restricted-data" });\n}\n`);
  mkdirSync(join(FIXTURE_DIR, "jobs"), { recursive: true });
  writeFileSync(
    join(FIXTURE_DIR, "jobs", "record.ts"),
    `import { getDb } from "@modunexo/sdk";\nexport default async function (ctx: { payload: { id: number } }) {\n  await getDb("${FIXTURE_ID}").query("insert into items (id) values ($1)", [ctx.payload.id]);\n}\n`,
  );
  writeFileSync(
    join(FIXTURE_DIR, "web", "enqueue.ts"),
    `import { enqueueJob } from "@modunexo/sdk";\nexport async function POST(request: Request) {\n  const { id } = await request.json();\n  return Response.json(await enqueueJob("${FIXTURE_ID}", "record", { id }, { dedupeKey: "record-" + id }));\n}\n`,
  );
  writeFileSync(
    join(FIXTURE_DIR, "jobs", "emit.ts"),
    `import { publishEvent } from "@modunexo/sdk";\nexport default async function (ctx: { payload: { n: number } }) {\n  await publishEvent("${FIXTURE_ID}", "pinged", { from: "worker", n: ctx.payload.n });\n}\n`,
  );
  writeFileSync(
    join(FIXTURE_DIR, "jobs", "on_pinged.ts"),
    `import { getDb } from "@modunexo/sdk";\nexport default async function (ctx: { payload: { event: { id: number } } }) {\n  await getDb("${FIXTURE_ID}").query("insert into items (id) values ($1)", [1000 + ctx.payload.event.id]);\n}\n`,
  );
  // Writes a row and publishes in one module transaction; `fail` throws after publishing, so both must vanish.
  writeFileSync(
    join(FIXTURE_DIR, "web", "publish.ts"),
    `import { getDb, publishEvent } from "@modunexo/sdk";
export async function POST(request: Request) {
  const { name, n, fail } = await request.json();
  try {
    const result = await getDb("${FIXTURE_ID}").transaction(async (tx) => {
      await tx.query("insert into items (id) values ($1)", [n]);
      const published = await publishEvent("${FIXTURE_ID}", name, { n }, { tx });
      if (fail) throw new Error("rolled back on purpose");
      return published;
    });
    return Response.json(result);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
`,
  );
  // Stores the request body as a file; `rollback` does it inside a module transaction that is then abandoned.
  writeFileSync(
    join(FIXTURE_DIR, "web", "upload.ts"),
    `import { getDb, putFile } from "@modunexo/sdk";
export async function POST(request: Request) {
  if (request.body === null) return Response.json({ error: "no body" }, { status: 400 });
  const body = request.body;
  const name = request.headers.get("x-file-name") ?? "upload.bin";
  const ref = request.headers.get("x-file-ref");
  const input = { name, data: body, ...(ref === null ? {} : { ref }) };
  try {
    if (new URL(request.url).searchParams.get("rollback") !== null) {
      let id = "";
      try {
        await getDb("${FIXTURE_ID}").transaction(async (tx) => {
          id = (await putFile("${FIXTURE_ID}", input, { tx })).id;
          throw new Error("rolled back on purpose");
        });
      } catch {
        // the point of the case
      }
      return Response.json({ id, rolledBack: true });
    }
    return Response.json(await putFile("${FIXTURE_ID}", input));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 422 });
  }
}
`,
  );
  writeFileSync(join(FIXTURE_DIR, "web", "items.ts"), `export async function GET() {\n  return Response.json({ items: [1, 2, 3] });\n}\n`);
  writeFileSync(join(FIXTURE_DIR, "web", "send.ts"), `export async function POST(request: Request) {\n  return Response.json({ sent: await request.json() });\n}\n`);
  writeFileSync(join(FIXTURE_DIR, "web", "hook.ts"), `export async function POST(request: Request) {\n  return Response.json({ received: await request.json() });\n}\n`);
  writeFileSync(join(FIXTURE_DIR, "web", "open-data.ts"), `export async function GET() {\n  return Response.json({ open: true });\n}\n`);
  // What `npm install` does for a workspace package: a link from node_modules to the package folder.
  mkdirSync(FIXTURE_SCOPE_DIR, { recursive: true });
  symlinkSync("../../modules/e2e-fixture", join(FIXTURE_SCOPE_DIR, "fixture"));
}

/** An open server-sent-events request: what has arrived so far, and a way to wait for more. */
function openStream(path: string, headers: Record<string, string>) {
  let text = "";
  let status = 0;
  let contentType: string | string[] | undefined;
  const req = httpRequest({ host: "127.0.0.1", port, method: "GET", path, headers }, (res) => {
    status = res.statusCode ?? 0;
    contentType = res.headers["content-type"];
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => (text += chunk));
    res.on("error", () => undefined);
  });
  req.on("error", () => undefined);
  req.end();
  return {
    get text() {
      return text;
    },
    get status() {
      return status;
    },
    get contentType() {
      return contentType;
    },
    async until(done: () => boolean, ms = 15_000): Promise<void> {
      const deadline = Date.now() + ms;
      while (!done()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for the stream; status ${status}, text so far:\n${text}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
    close: () => req.destroy(),
  };
}

/** The data frames of a stream's text: its comments and the retry line are left out. */
const frames = (text: string): Array<{ id?: string; event?: string; data?: string }> =>
  text
    .split("\n\n")
    .filter((block) => block.trim() !== "" && !block.startsWith(":") && !block.startsWith("retry:"))
    .map((block) => Object.fromEntries(block.split("\n").map((line) => [line.slice(0, line.indexOf(": ")), line.slice(line.indexOf(": ") + 2)])));

const put = (path: string, body: unknown, headers: Record<string, string> = {}) => call("PUT", path, { origin: origin(), ...headers }, body);
/** The page text as a reader sees it: React separates adjacent text nodes with `<!-- -->` markers in server HTML. */
const html = (reply: Reply) => reply.body.replace(/<!-- -->/g, "");

describe("web app: with a module installed", () => {
  let cookie = "";
  let userCookie = "";
  let operatorCookie = "";

  before(async () => {
    if (db === undefined) return;
    const stopped = await stopServer();
    assert.equal(stopped.code, 0, "the first server stops cleanly before the module is installed");
    writeFixture();
    const installed = await run(["--import", "tsx", CLI, "modules", "install", FIXTURE_ID], appEnv);
    assert.equal(installed.code, 0, `install failed:\n${installed.output}`);
    await buildApp();
    await startServer();

    await db.query("delete from core.auth_rate_limit");
    const reply = await signIn(PASSWORD);
    assert.equal(reply.status, 200, reply.body);
    cookie = cookieOf(reply);

    // A signed-in user who is not an administrator.
    const auth = createAuth({ pool: db, masterKey: MASTER_KEY, baseURL: "http://localhost", validateSchema: false });
    await auth.api.createUser({ body: { email: "viewer@example.test", name: "Viewer", password: PASSWORD, role: "user" } });
    await db.query("delete from core.auth_rate_limit");
    const viewer = await call("POST", "/api/auth/sign-in/email", { origin: origin() }, { email: "viewer@example.test", password: PASSWORD });
    assert.equal(viewer.status, 200, viewer.body);
    userCookie = cookieOf(viewer);

    await auth.api.createUser({ body: { email: "operator@example.test", name: "Operator", password: PASSWORD, role: "operator" as never } });
    await db.query("delete from core.auth_rate_limit");
    const operator = await call("POST", "/api/auth/sign-in/email", { origin: origin() }, { email: "operator@example.test", password: PASSWORD });
    assert.equal(operator.status, 200, operator.body);
    operatorCookie = cookieOf(operator);
  });

  test("the sidebar lists the module's entry under its group, with its icon, and the page is inside the shell", async () => {
    const home = await call("GET", "/", { cookie });
    assert.match(html(home), /href="\/e2e-fixture"/);
    assert.match(html(home), />Fixtures</, "the group heading");
    assert.match(html(home), /1 module is enabled/);

    const page = await call("GET", "/e2e-fixture", { cookie });
    assert.equal(page.status, 200);
    assert.match(html(page), /Fixture page/);
    assert.match(html(page), /href="\/settings"/, "the module's page is drawn inside the shell, sidebar included");
    assert.match(html(page), /data-module="e2e-fixture"/, "and its content is scoped to the module");
    assert.match(html(page), /Title setting: \[Untitled\]/, "the module's server code reads its setting, here the declared default");
    assert.equal((await call("GET", "/e2e-fixture")).status, 307, "and it is behind the gate like everything else");
  });

  test("the Apps screen lists the module", async () => {
    const apps = await call("GET", "/apps", { cookie });
    assert.match(html(apps), /E2E Fixture/);
  });

  test("a signed-in non-administrator is told they cannot see settings and is shown none of the values", async () => {
    const page = await call("GET", "/settings", { cookie: userCookie });
    assert.equal(page.status, 200);
    assert.match(html(page), /Only an administrator can view or change settings/);
    for (const text of ["Page size", "Export directory", "Save settings", "Save appearance"]) assert.ok(!html(page).includes(text), `"${text}" must not be shown`);
  });

  test("the settings screen shows the declared fields, the appearance, and what is still required", async () => {
    const page = await call("GET", "/settings", { cookie });
    assert.equal(page.status, 200);
    for (const text of ["Appearance", "E2E Fixture", "Site title", "Page size", "Report format", "Export directory", "API token", "2 required settings are not set"]) {
      assert.ok(html(page).includes(text), `expected "${text}" on the settings screen`);
    }
  });

  test("a path that asks for a permission is served to an administrator and refused to everyone else", async () => {
    for (const path of ["/e2e-fixture/restricted", "/e2e-fixture/area/5", "/e2e-fixture/data"]) {
      assert.equal((await call("GET", path, { cookie })).status, 200, `administrator ${path}`);
      const refused = await call("GET", path, { cookie: userCookie });
      assert.equal(refused.status, 403, `user ${path}`);
      assert.equal(refused.body, "Forbidden");
    }
    // A trailing slash is Next.js's to normalise; whatever it does, the user is never served the page.
    assert.notEqual((await call("GET", "/e2e-fixture/area/5/", { cookie: userCookie })).status, 200);
    assert.match(html(await call("GET", "/e2e-fixture/area/5", { cookie })), /Area 5/);
    assert.match((await call("GET", "/e2e-fixture/data", { cookie })).body, /restricted-data/);
    assert.ok(!(await call("GET", "/e2e-fixture/data", { cookie: userCookie })).body.includes("restricted-data"));
  });

  test("an encoded spelling of a protected path never reaches the protected content, signed in or not", async () => {
    const spellings = [
      "/e2e-fixture/%72estricted",
      "/e2e-fixture/restrict%65d",
      "/e2e-fixture%2Frestricted",
      "/e2e-fixture/%2572estricted",
      "/e2e-fixture/area/%35",
      "/e2e-fixture/%61rea/5",
      "/e2e-fixture/da%74a",
      "/e2e-fixture/data%2f",
      "/%65%32e-fixture/restricted",
    ];
    for (const path of spellings) {
      const visitors: [string, Record<string, string>][] = [
        ["a user", { cookie: userCookie }],
        ["nobody", {}],
      ];
      for (const [label, who] of visitors) {
        const reply = await call("GET", path, who);
        assert.notEqual(reply.status, 200, `${path} as ${label}`);
        assert.ok(!reply.body.includes("Restricted page") && !reply.body.includes("restricted-data") && !/Area \d/.test(reply.body), path);
      }
    }
  });

  test("a path that asks for nothing stays open to a signed-in user, and the link that is hidden is hidden", async () => {
    assert.equal((await call("GET", "/e2e-fixture", { cookie: userCookie })).status, 200);
    assert.equal((await call("GET", "/e2e-fixture/open-data", { cookie: userCookie })).status, 200);
    const userHome = html(await call("GET", "/", { cookie: userCookie }));
    assert.match(userHome, /href="\/e2e-fixture"/);
    assert.ok(!userHome.includes('href="/e2e-fixture/area"'), "the user is not shown the restricted link");
    assert.match(html(await call("GET", "/", { cookie })), /href="\/e2e-fixture\/area"/, "the administrator is");
  });

  test("an operator uses the module's restricted paths and sees its links, but cannot change the platform", async () => {
    for (const path of ["/e2e-fixture/restricted", "/e2e-fixture/area/5", "/e2e-fixture/data"]) {
      assert.equal((await call("GET", path, { cookie: operatorCookie })).status, 200, `operator ${path}`);
    }
    assert.match(html(await call("GET", "/", { cookie: operatorCookie })), /href="\/e2e-fixture\/area"/);

    // The platform's own writes stay with the administrator.
    assert.equal((await put("/api/settings/security", { trustedProxies: "10.0.0.2" }, { cookie: operatorCookie })).status, 403);
    assert.equal((await put(`/api/settings/modules/${FIXTURE_ID}`, { values: {} }, { cookie: operatorCookie })).status, 403);
    assert.equal((await call("GET", "/api/apps", { cookie: operatorCookie })).status, 403);
    assert.equal((await call("POST", "/api/apps/operations", { cookie: operatorCookie, origin: origin() }, {})).status, 403);
    const settings = html(await call("GET", "/settings", { cookie: operatorCookie }));
    assert.match(settings, /Only an administrator can view or change settings/);
    assert.match(html(await call("GET", "/apps", { cookie: operatorCookie })), /Only an administrator can add, enable, disable or uninstall modules/);

    // Nor can it use the library's own administrator endpoints to make itself one.
    const promote = await call("POST", "/api/auth/admin/set-role", { cookie: operatorCookie, origin: origin() }, { userId: "x", role: "admin" });
    assert.ok(promote.status === 401 || promote.status === 403, `set-role answered ${promote.status}`);
    assert.equal((await db!.query(`select "role" from core.auth_user where "email" = 'operator@example.test'`)).rows[0].role, "operator");
  });

  test("asks for a session before it talks about permissions", async () => {
    // A module's route is not under /api (that prefix is the shell's), so without a session it is sent to sign in.
    for (const path of ["/e2e-fixture/restricted", "/e2e-fixture/data", "/e2e-fixture/area/5"]) {
      const reply = await call("GET", path);
      assert.equal(reply.status, 307, path);
      assert.equal(location(reply), "/login");
      assert.ok(!reply.body.includes("restricted-data"));
    }
  });

  test("while sign-in is off the local operator holds every permission and a public address still gets nothing", async () => {
    await setSignInMode(db!, "disabled", "test");
    try {
      assert.equal((await call("GET", "/e2e-fixture/restricted")).status, 200);
      assert.equal((await call("GET", "/e2e-fixture/data")).status, 200);
      assert.equal((await call("GET", "/e2e-fixture/data", { "x-forwarded-for": "8.8.8.8" })).status, 403);
    } finally {
      await setSignInMode(db!, "required", "test");
    }
  });

  test("behind a trusted proxy the sign-in limit counts the client the proxy saw, reading from the right", async () => {
    await setTrustedProxies(db!, "127.0.0.1", "test");
    try {
      await db!.query("delete from core.auth_rate_limit");
      const wrong = (headers: Record<string, string>) => signIn("wrong password here", headers).then((reply) => reply.status);
      const first: number[] = [];
      for (let i = 0; i < 6; i++) first.push(await wrong({ "x-forwarded-for": "203.0.113.7" }));
      assert.deepEqual(first, [401, 401, 401, 401, 401, 429], "one client is limited");
      assert.equal(await wrong({ "x-forwarded-for": "203.0.113.8" }), 401, "another client is not locked out with it");
      assert.equal(await wrong({}), 401, "nor is a request that carries no forwarded address");
      assert.equal(await wrong({ "x-forwarded-for": "198.51.100.99, 203.0.113.7" }), 429, "a forged first entry does not buy a new identity");
      assert.equal(await wrong({ "x-forwarded-for": "garbage" }), 401, "junk falls back to the proxy's own bucket, and does not mint identities");
    } finally {
      await setTrustedProxies(db!, "", "test");
      await db!.query("delete from core.auth_rate_limit");
    }
  });

  test("with no trusted proxy a forwarded header is never believed: every client behind it shares one bucket", async () => {
    await db!.query("delete from core.auth_rate_limit");
    const seen: number[] = [];
    for (let i = 1; i <= 7; i++) seen.push((await signIn("wrong password here", { "x-forwarded-for": `203.0.113.${i}` })).status);
    assert.deepEqual(seen.slice(0, 5), [401, 401, 401, 401, 401]);
    assert.ok(seen.slice(5).every((status) => status === 429), seen.join(" "));
    await db!.query("delete from core.auth_rate_limit");
  });

  test("the security settings: shown to an administrator, written through the API, validated, audited", async () => {
    assert.equal((await put("/api/settings/security", { trustedProxies: "10.0.0.2" })).status, 401);
    assert.equal((await put("/api/settings/security", { trustedProxies: "10.0.0.2" }, { cookie, origin: "https://evil.example" })).status, 403);
    assert.equal((await put("/api/settings/security", { trustedProxies: "10.0.0.2" }, { cookie: userCookie })).status, 403);
    assert.equal((await put("/api/settings/security", { trustedProxies: "10.0.0.2, nope" }, { cookie })).status, 422);
    assert.equal((await put("/api/settings/security", { trustedProxies: "0.0.0.0/0" }, { cookie })).status, 422);
    assert.equal((await put("/api/settings/security", { other: 1 }, { cookie })).status, 400);
    assert.equal((await db!.query("select 1 from core.platform_settings where key = 'security.trustedProxies'")).rowCount, 0, "nothing was stored by any refusal");

    const saved = await put("/api/settings/security", { trustedProxies: "10.0.0.2\n192.168.1.0/24" }, { cookie });
    assert.equal(saved.status, 200, saved.body);
    assert.deepEqual((JSON.parse(saved.body) as { trustedProxies: string[] }).trustedProxies, ["10.0.0.2", "192.168.1.0/24"]);

    const page = html(await call("GET", "/settings", { cookie }));
    assert.match(page, />Security</);
    assert.match(page, /10\.0\.0\.2/);
    assert.match(page, /192\.168\.1\.0\/24/);
    assert.ok(!html(await call("GET", "/settings", { cookie: userCookie })).includes("192.168.1.0/24"), "a non-administrator is shown none of it");

    const events = (await db!.query("select actor, action from core.settings_events where key = 'security.trustedProxies' and actor = $1 order by id", [EMAIL])).rows;
    assert.deepEqual(events, [{ actor: EMAIL, action: "set" }]);

    // What is stored but no longer valid is ignored, and the screen says so instead of looking as if it were active.
    await db!.query("update core.platform_settings set value = '[\"0.0.0.0/1\"]'::jsonb where key = 'security.trustedProxies'");
    const stale = html(await call("GET", "/settings", { cookie }));
    assert.match(stale, /The stored list is not valid any more/);
    assert.ok(!stale.includes("0.0.0.0/1"), "and it does not show the ignored list as if it were trusted");

    assert.equal((await put("/api/settings/security", { trustedProxies: [] }, { cookie })).status, 200);
    assert.equal((await db!.query("select 1 from core.platform_settings where key = 'security.trustedProxies'")).rowCount, 0);
  });

  test("refuses a write without a session, from another origin, without an origin, and from a non-administrator", async () => {
    const body = { values: { "site.title": "X" } };
    assert.equal((await put(`/api/settings/modules/${FIXTURE_ID}`, body)).status, 401);
    assert.equal((await put(`/api/settings/modules/${FIXTURE_ID}`, body, { cookie, origin: "https://evil.example" })).status, 403);
    assert.equal((await call("PUT", `/api/settings/modules/${FIXTURE_ID}`, { cookie }, body)).status, 403);
    const viewer = await put(`/api/settings/modules/${FIXTURE_ID}`, body, { cookie: userCookie });
    assert.equal(viewer.status, 403);
    const rows = await db!.query("select 1 from core.module_settings where module_id = $1", [FIXTURE_ID]);
    assert.equal(rows.rowCount, 0, "nothing was written by any of them");
  });

  test("a form with one bad field changes nothing and reports the error by key", async () => {
    const reply = await put(`/api/settings/modules/${FIXTURE_ID}`, { values: { "site.title": "Valid title", "page.size": "lots" } }, { cookie });
    assert.equal(reply.status, 422);
    const data = JSON.parse(reply.body) as { errors: Record<string, string> };
    assert.match(data.errors["page.size"]!, /page\.size/);
    const rows = await db!.query("select 1 from core.module_settings where module_id = $1", [FIXTURE_ID]);
    assert.equal(rows.rowCount, 0);
  });

  test("an unknown module is 404 and an undeclared key is 400", async () => {
    assert.equal((await put("/api/settings/modules/no-such-module", { values: {} }, { cookie })).status, 404);
    assert.equal((await put(`/api/settings/modules/${FIXTURE_ID}`, { values: { "not.declared": "x" } }, { cookie })).status, 400);
    assert.equal((await put(`/api/settings/modules/${FIXTURE_ID}`, "not an object", { cookie })).status, 400);
  });

  test("saves settings, encrypts the secret, never returns or renders it, and audits who did it", async () => {
    const reply = await put(
      `/api/settings/modules/${FIXTURE_ID}`,
      { values: { "site.title": "Acme reports", "page.size": "50", "export.dir": "/srv/exports", "api.token": TOKEN_PLAIN } },
      { cookie },
    );
    assert.equal(reply.status, 200, reply.body);
    assert.ok(!reply.body.includes(TOKEN_PLAIN), "the response never carries the secret");

    const stored = (await db!.query("select key, value, secret from core.module_settings where module_id = $1 order by key", [FIXTURE_ID])).rows;
    const token = stored.find((row) => row.key === "api.token");
    assert.equal(token.value, null);
    assert.match(token.secret, /^v1\./);
    assert.ok(!JSON.stringify(stored).includes(TOKEN_PLAIN), "the database never holds it in the clear");
    assert.equal(stored.find((row) => row.key === "page.size").value, 50);

    const modulePage = await call("GET", "/e2e-fixture", { cookie });
    assert.match(html(modulePage), /Title setting: \[Acme reports\]/, "the module's server code sees the value that was just saved");

    const page = await call("GET", "/settings", { cookie });
    assert.ok(!html(page).includes(TOKEN_PLAIN));
    assert.match(html(page), /Set\. Type to replace it/);
    assert.ok(!html(page).includes("required settings are not set") && !html(page).includes("required setting is not set"), "nothing is incomplete any more");

    const events = (await db!.query("select scope, key, action, actor from core.settings_events where scope = $1 order by id", [FIXTURE_ID])).rows;
    assert.deepEqual(events.map((e) => e.key).sort(), ["api.token", "export.dir", "page.size", "site.title"]);
    assert.ok(events.every((e) => e.actor === EMAIL && e.action === "set"));
  });

  test("a blank secret keeps the stored one, and naming it in clear removes it", async () => {
    const keep = await put(`/api/settings/modules/${FIXTURE_ID}`, { values: { "api.token": "" } }, { cookie });
    assert.equal(keep.status, 200);
    assert.equal((await db!.query("select 1 from core.module_settings where module_id = $1 and key = 'api.token'", [FIXTURE_ID])).rowCount, 1);
    const clear = await put(`/api/settings/modules/${FIXTURE_ID}`, { values: {}, clear: ["api.token"] }, { cookie });
    assert.equal(clear.status, 200);
    assert.equal((await db!.query("select 1 from core.module_settings where module_id = $1 and key = 'api.token'", [FIXTURE_ID])).rowCount, 0);
  });

  test("changes the platform appearance for every page, validated as a whole", async () => {
    assert.equal((await put("/api/settings/appearance", { accentHue: 999 }, { cookie })).status, 422);
    assert.equal((await put("/api/settings/appearance", { theme: "dark", accentHue: 12345 }, { cookie })).status, 422);
    assert.equal((await put("/api/settings/appearance", { color: "red" }, { cookie })).status, 400);
    const stored = await db!.query("select 1 from core.platform_settings where key like 'appearance.%'");
    assert.equal(stored.rowCount, 0, "a refused change applies none of it");

    const saved = await put("/api/settings/appearance", { theme: "dark", accentHue: 140, radius: "round" }, { cookie });
    assert.equal(saved.status, 200, saved.body);
    for (const path of ["/", "/settings", "/e2e-fixture"]) {
      const page = await call("GET", path, { cookie });
      assert.match(html(page), /oklch\(0\.49 0\.15 140\)/, `${path} carries the new accent`);
      assert.match(html(page), /--radius:1rem/);
    }
    const login = await call("GET", "/login");
    assert.match(html(login), /oklch\(0\.49 0\.15 140\)/, "the sign-in page follows it too");
    assert.match(html(login), /matchMedia|"dark"/);
  });

  test("a module can have its own accent and corners, and can go back to following the platform", async () => {
    assert.equal((await put(`/api/settings/modules/${FIXTURE_ID}/appearance`, { theme: "dark" }, { cookie })).status, 400, "the theme is not per module");
    assert.equal((await put(`/api/settings/modules/${FIXTURE_ID}/appearance`, { accentHue: -5 }, { cookie })).status, 422);

    const set = await put(`/api/settings/modules/${FIXTURE_ID}/appearance`, { accentHue: 20, radius: "sharp" }, { cookie });
    assert.equal(set.status, 200, set.body);
    const page = await call("GET", "/e2e-fixture", { cookie });
    assert.match(html(page), /\[data-module="e2e-fixture"\]\{[^}]*--accent:oklch\(0\.49 0\.15 20\)/);
    assert.match(html(page), /\[data-module="e2e-fixture"\]\{--radius:0\.25rem/);

    // Text that is not a number is refused and must not clear the override that is stored.
    const garbage = await put(`/api/settings/modules/${FIXTURE_ID}/appearance`, { accentHue: "abc" }, { cookie });
    assert.equal(garbage.status, 422);
    assert.match(html(await call("GET", "/e2e-fixture", { cookie })), /\[data-module="e2e-fixture"\]\{[^}]*--accent:oklch\(0\.49 0\.15 20\)/);

    const cleared = await put(`/api/settings/modules/${FIXTURE_ID}/appearance`, { accentHue: null, radius: null }, { cookie });
    assert.equal(cleared.status, 200);
    assert.doesNotMatch(html(await call("GET", "/e2e-fixture", { cookie })), /\[data-module=/);
  });

  test("while sign-in is off the local operator can change settings and a public address cannot", async () => {
    await setSignInMode(db!, "disabled", "test");
    try {
      const local = await put("/api/settings/appearance", { accentHue: 200 });
      assert.equal(local.status, 200, local.body);
      const remote = await put("/api/settings/appearance", { accentHue: 10 }, { "x-forwarded-for": "8.8.8.8" });
      assert.equal(remote.status, 403);
      const actor = await db!.query("select actor from core.settings_events where scope = 'platform' order by id desc limit 1");
      assert.equal(actor.rows[0].actor, "local operator");
    } finally {
      await setSignInMode(db!, "required", "test");
    }
  });

  test("a public route answers without a session, and only to a signed request", async () => {
    const secret = "whsec_e2e_0123456789abcdef";
    assert.equal((await put(`/api/settings/modules/${FIXTURE_ID}`, { values: { "hook.secret": secret } }, { cookie })).status, 200);
    const path = "/hooks/e2e-fixture/events";
    const signature = createHmac("sha256", secret).update(JSON.stringify({ event: "ping" })).digest("hex");

    const unsigned = await call("POST", path, {}, { event: "ping" });
    assert.equal(unsigned.status, 401);
    assert.equal(unsigned.body, "Unauthorized");
    assert.equal((await call("POST", path, { "x-signature": "0".repeat(64) }, { event: "ping" })).status, 401);
    assert.equal((await call("POST", path, { "x-signature": signature }, { event: "tampered" })).status, 401);

    const signed = await call("POST", path, { "x-signature": signature }, { event: "ping" });
    assert.equal(signed.status, 200, signed.body);
    assert.deepEqual(JSON.parse(signed.body), { received: { event: "ping" } });

    assert.equal((await call("GET", path)).status, 405, "the module exports no GET, and the gate does not make that an opening");
    for (const other of ["/hooks/e2e-fixture", "/hooks/e2e-fixture/other", "/hooks/e2e-fixture/events/extra", "/hooks/e2e-fixture/events%2F..%2F..%2Fsettings", "/hooks/e2e-fixture/%2e%2e/settings"]) {
      const reply = await call("POST", other, { "x-signature": signature }, { event: "ping" });
      assert.equal(reply.status, 307, `${other} stays behind the gate`);
      assert.equal(reply.headers.location, "/login");
    }
  });

  test("a public route with no secret set refuses everything", async () => {
    await db!.query("delete from core.module_settings where module_id = $1 and key = 'hook.secret'", [FIXTURE_ID]);
    const signature = createHmac("sha256", "").update(JSON.stringify({ event: "ping" })).digest("hex");
    assert.equal((await call("POST", "/hooks/e2e-fixture/events", { "x-signature": signature }, { event: "ping" })).status, 401);
  });

  test("a token route answers without a session, and only to a token that holds its scope", async () => {
    const cli = (...args: string[]) => run(["--import", "tsx", CLI, "tokens", ...args], appEnv);
    const made = await cli("create", FIXTURE_ID, "--name", "e2e reader", "--scope", "messages.read");
    assert.equal(made.code, 0, made.output);
    const token = /mdnx_[0-9a-f]{8}_[A-Za-z0-9_-]{43}/.exec(made.output)?.[0];
    assert.ok(token !== undefined, made.output);
    const bearer = { authorization: `Bearer ${token}` };

    const none = await call("GET", "/svc/e2e-fixture/items");
    assert.equal(none.status, 401);
    assert.equal(none.headers["www-authenticate"], "Bearer");
    assert.equal((await call("GET", "/svc/e2e-fixture/items", { authorization: `Bearer mdnx_${"0".repeat(8)}_${"A".repeat(43)}` })).status, 401);

    const ok = await call("GET", "/svc/e2e-fixture/items", bearer);
    assert.equal(ok.status, 200, ok.body);
    assert.deepEqual(JSON.parse(ok.body), { items: [1, 2, 3] });

    const wrongScope = await call("POST", "/svc/e2e-fixture/send", bearer, { text: "hi" });
    assert.equal(wrongScope.status, 403, "a valid token without the route's scope is told so");
    assert.equal((await call("GET", "/svc/e2e-fixture/items", { cookie })).status, 401, "a session is not a token: the route is for machines");

    for (const other of ["/svc/e2e-fixture", "/svc/e2e-fixture/other", "/svc/e2e-fixture/items/extra", "/svc/e2e-fixture/items%2F..%2F..%2Fsettings"]) {
      const reply = await call("GET", other, bearer);
      assert.equal(reply.status, 307, `${other} stays behind the gate`);
      assert.equal(reply.headers.location, "/login");
    }

    const listed = await cli("list", FIXTURE_ID);
    assert.match(listed.output, /e2e reader\s+[0-9a-f]{8}\s+messages\.read\s+active/);
    assert.ok(!listed.output.includes(token), "the list never shows a token");
    const id = (await db!.query("select id from core.service_tokens where module_id = $1", [FIXTURE_ID])).rows[0].id;
    assert.ok(((await db!.query("select last_used_at from core.service_tokens where id = $1", [id])).rows[0].last_used_at) !== null, "a use is noted");
    assert.equal((await cli("revoke", String(id))).code, 0);
    assert.equal((await call("GET", "/svc/e2e-fixture/items", bearer)).status, 401, "a revoked token stops working at once, with no restart");
  });

  test("a route enqueues a job, and the worker process runs it with the module's database access", async () => {
    const queued = await call("POST", "/e2e-fixture/enqueue", { cookie, origin: origin() }, { id: 41 });
    assert.equal(queued.status, 200, queued.body);
    const { id, deduplicated } = JSON.parse(queued.body) as { id: string; deduplicated: boolean };
    assert.equal(deduplicated, false);
    assert.equal((await call("POST", "/e2e-fixture/enqueue", { cookie, origin: origin() }, { id: 41 })).body, JSON.stringify({ id: Number(id), deduplicated: true }), "the dedupe key holds while it is active");
    assert.equal((await call("POST", "/e2e-fixture/enqueue", {}, { id: 41 })).status, 307, "and the route is behind the gate like any other");
    assert.equal((await db!.query("select status, enqueued_by from core.jobs where id = $1", [id])).rows[0].status, "queued");

    const worker = spawn(process.execPath, ["--import", "tsx", CLI, "worker", "--poll-ms", "100"], { cwd: REPO_ROOT, env: childEnv(appEnv) });
    let output = "";
    worker.stdout.on("data", (chunk) => (output += chunk));
    worker.stderr.on("data", (chunk) => (output += chunk));
    const exited = new Promise<number | null>((resolve) => worker.once("exit", resolve));
    try {
      let done = false;
      for (let i = 0; i < 300 && !done; i++) {
        done = (await db!.query("select status from core.jobs where id = $1", [id])).rows[0].status === "succeeded";
        if (!done) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(done, `the worker did not run the job:\n${output}`);
      assert.deepEqual((await db!.query("select id from e2e_fixture.items order by id")).rows, [{ id: 41 }], "the handler wrote through getDb");
      worker.kill("SIGTERM");
      assert.equal(await exited, 0, output);
    } finally {
      worker.kill("SIGKILL");
    }
  });

  test("a stream carries the events a route publishes inside its transaction, resumes by cursor, and never carries an event without a permission", async () => {
    assert.equal((await call("GET", "/api/events")).status, 401, "a stream needs a session");
    for (const [query, expected] of [
      ["?types=e2e-fixture.private.note", 400],
      ["?types=nobody.nothing", 400],
      ["?after=abc", 400],
    ] as const) {
      const refused = openStream(`/api/events${query}`, { cookie });
      await refused.until(() => refused.status !== 0);
      assert.equal(refused.status, expected, query);
      refused.close();
    }

    const publish = (name: string, n: number, fail = false) => call("POST", "/e2e-fixture/publish", { cookie, origin: origin() }, { name, n, fail });
    const stream = openStream("/api/events", { cookie });
    await stream.until(() => stream.text.includes("retry: 3000"));
    assert.equal(stream.status, 200);
    assert.match(String(stream.contentType), /^text\/event-stream/);

    const first = JSON.parse((await publish("pinged", 5001)).body) as { id: number };
    await publish("private.note", 5002);
    const second = JSON.parse((await publish("pinged", 5003)).body) as { id: number };
    await stream.until(() => frames(stream.text).length >= 2);
    assert.deepEqual(
      frames(stream.text).map((f) => [Number(f.id), f.event, JSON.parse(f.data!).payload]),
      [[first.id, `${FIXTURE_ID}.pinged`, { n: 5001 }], [second.id, `${FIXTURE_ID}.pinged`, { n: 5003 }]],
      "only the event tied to a permission, in order",
    );
    assert.equal((await db!.query("select 1 from core.events where type = $1", [`${FIXTURE_ID}.private.note`])).rowCount, 1, "the private event exists but is not streamed");

    const failed = await publish("pinged", 5004, true);
    assert.equal(failed.status, 500);
    assert.equal((await db!.query("select 1 from e2e_fixture.items where id = 5004")).rowCount, 0, "the row is gone");
    assert.equal((await db!.query("select 1 from core.events where payload->>'n' = '5004'")).rowCount, 0, "and so is the event");

    stream.close();
    const third = JSON.parse((await publish("pinged", 5005)).body) as { id: number };
    const resumed = openStream("/api/events", { cookie, "last-event-id": String(second.id) });
    await resumed.until(() => frames(resumed.text).length >= 1);
    assert.deepEqual(frames(resumed.text).map((f) => Number(f.id)), [third.id], "it continues after the cursor, with what it missed");
    resumed.close();

    const ahead = openStream("/api/events?after=999999999", { cookie });
    await ahead.until(() => frames(ahead.text).length >= 1);
    assert.equal(frames(ahead.text)[0]!.event, "reset", "a cursor from another log is told to start over");
    ahead.close();
  });

  test("an event published by the worker process reaches an open stream, and the subscribed job runs", async () => {
    const stream = openStream("/api/events", { cookie });
    await stream.until(() => stream.text.includes("retry: 3000"));
    const queued = await run(["--import", "tsx", CLI, "jobs", "enqueue", FIXTURE_ID, "emit", "--payload", '{"n":6001}'], appEnv);
    assert.equal(queued.code, 0, queued.output);

    const worker = spawn(process.execPath, ["--import", "tsx", CLI, "worker", "--poll-ms", "100"], { cwd: REPO_ROOT, env: childEnv(appEnv) });
    let output = "";
    worker.stdout.on("data", (chunk) => (output += chunk));
    worker.stderr.on("data", (chunk) => (output += chunk));
    const exited = new Promise<number | null>((resolve) => worker.once("exit", resolve));
    try {
      await stream.until(() => frames(stream.text).some((f) => f.data?.includes('"from":"worker"')), 30_000);
      const heard = frames(stream.text).find((f) => f.data?.includes('"from":"worker"'))!;
      assert.equal(heard.event, `${FIXTURE_ID}.pinged`);
      assert.deepEqual(JSON.parse(heard.data!).payload, { from: "worker", n: 6001 });
      const eventId = Number(heard.id);
      let ran = false;
      for (let i = 0; i < 300 && !ran; i++) {
        ran = ((await db!.query("select 1 from e2e_fixture.items where id = $1", [1000 + eventId])).rowCount ?? 0) === 1;
        if (!ran) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(ran, `the subscribed job did not run:\n${output}`);
      worker.kill("SIGTERM");
      assert.equal(await exited, 0, output);
    } finally {
      worker.kill("SIGKILL");
      stream.close();
    }
  });

  test("a route stores a file through the SDK; a viewer with the permission downloads it as an attachment and everyone else is refused", async () => {
    const upload = (body: string | Buffer, headers: Record<string, string> = {}, query = "") =>
      callRaw("POST", `/e2e-fixture/upload${query}`, { cookie, origin: origin(), ...headers }, body);
    const made = await upload("hello file", { "x-file-name": "notes ñ.txt", "x-file-ref": "message:7" });
    assert.equal(made.status, 200, made.body);
    const meta = JSON.parse(made.body) as { id: string; name: string; contentType: string; size: number; ref: string };
    assert.deepEqual([meta.name, meta.contentType, meta.size, meta.ref], ["notes ñ.txt", "text/plain", 10, "message:7"]);
    assert.equal((await db!.query("select count(*)::int as n from core.files where module_id = $1", [FIXTURE_ID])).rows[0].n, 1);
    assert.equal(existsSync(join(dataDir, "files", FIXTURE_ID, meta.id.slice(0, 2), meta.id)), true, "the bytes are under the data directory");

    const path = `/api/files/${FIXTURE_ID}/${meta.id}`;
    const got = await call("GET", path, { cookie });
    assert.equal(got.status, 200);
    assert.equal(got.body, "hello file");
    assert.equal(got.headers["content-type"], "text/plain");
    assert.equal(got.headers["content-length"], "10");
    assert.equal(got.headers["content-disposition"], `attachment; filename="notes _.txt"; filename*=UTF-8''notes%20%C3%B1.txt`);
    assert.equal(got.headers["x-content-type-options"], "nosniff");
    assert.equal(got.headers["content-security-policy"], "default-src 'none'; sandbox");
    assert.equal(got.headers["cache-control"], "private, no-store");
    assert.equal(got.headers["x-frame-options"], "DENY", "a download keeps the shell's other protections");

    // The route's own policy must not replace, or be replaced by, the page policy: pages keep theirs.
    for (const page of ["/login", "/"]) {
      const reply = await call("GET", page);
      assert.match(String(reply.headers["content-security-policy"]), /frame-ancestors 'none'/, page);
      assert.equal(reply.headers["x-frame-options"], "DENY", page);
    }

    assert.equal((await call("GET", path)).status, 401, "a download needs a session");
    const refused = await call("GET", path, { cookie: userCookie });
    assert.equal(refused.status, 403);
    assert.ok(!refused.body.includes("hello file"));
    assert.equal((await call("GET", path, { cookie: operatorCookie })).status, 200);
    for (const missing of [`/api/files/${FIXTURE_ID}/00000000-0000-4000-8000-000000000000`, `/api/files/${FIXTURE_ID}/${meta.id}x`, `/api/files/${FIXTURE_ID}/..%2F..%2Fetc%2Fpasswd`, `/api/files/nobody/${meta.id}`, `/api/files/hello/${meta.id}`]) {
      assert.equal((await call("GET", missing, { cookie })).status, 404, missing);
    }
  });

  test("the type of a stored file comes from its bytes, and a file over the limit, of a type the module does not take, or empty is refused", async () => {
    const upload = (body: string | Buffer, headers: Record<string, string> = {}, query = "") =>
      callRaw("POST", `/e2e-fixture/upload${query}`, { cookie, origin: origin(), ...headers }, body);
    const rows = async () => (await db!.query("select count(*)::int as n from core.files where module_id = $1", [FIXTURE_ID])).rows[0].n as number;
    const before = await rows();

    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)]);
    const sent = await upload(png, { "x-file-name": "looks-like-text.txt" });
    assert.equal(sent.status, 200, sent.body);
    const pngMeta = JSON.parse(sent.body) as { id: string; contentType: string };
    assert.equal(pngMeta.contentType, "image/png", "not what the name says");
    const fetched = await call("GET", `/api/files/${FIXTURE_ID}/${pngMeta.id}`, { cookie });
    assert.equal(fetched.headers["content-type"], "image/png");
    assert.equal(fetched.headers["content-length"], String(png.length));

    const html = await upload("<script>alert(1)</script>", { "x-file-name": "page.html" });
    assert.equal(JSON.parse(html.body).contentType, "text/plain", "markup is never announced as a page");

    const big = await upload("x".repeat(3000), { "x-file-name": "big.txt" });
    assert.equal(big.status, 422);
    assert.match(big.body, /over the limit of 2048 bytes/);
    const pdf = await upload("%PDF-1.4 not accepted", { "x-file-name": "doc.pdf" });
    assert.equal(pdf.status, 422);
    assert.match(pdf.body, /does not accept application\/pdf files/);
    const empty = await upload("", { "x-file-name": "empty.txt" });
    assert.ok(empty.status === 400 || empty.status === 422, `empty body answered ${empty.status}`);
    assert.equal(await rows(), before + 2, "only the two accepted files were stored");
  });

  test("a file written in a transaction that rolls back has no row, cannot be downloaded, and its bytes wait for the sweep", async () => {
    const reply = await callRaw("POST", `/e2e-fixture/upload?rollback=1`, { cookie, origin: origin(), "x-file-name": "ghost.txt" }, "never committed");
    assert.equal(reply.status, 200, reply.body);
    const { id } = JSON.parse(reply.body) as { id: string };
    assert.match(id, /^[0-9a-f-]{36}$/);
    assert.equal((await db!.query("select 1 from core.files where id = $1", [id])).rowCount, 0);
    assert.equal((await call("GET", `/api/files/${FIXTURE_ID}/${id}`, { cookie })).status, 404);
    assert.equal(existsSync(join(dataDir, "files", FIXTURE_ID, id.slice(0, 2), id)), true, "the bytes were written before the transaction ended");
  });

  test("uninstalling the module with purge removes its settings and its appearance, and keeps the audit trail", async () => {
    await put(`/api/settings/modules/${FIXTURE_ID}`, { values: { "site.title": "Again" } }, { cookie });
    await put(`/api/settings/modules/${FIXTURE_ID}/appearance`, { accentHue: 30 }, { cookie });
    assert.ok(((await db!.query("select 1 from core.files where module_id = $1", [FIXTURE_ID])).rowCount ?? 0) > 0, "the module has stored files");
    const removed = await run(["--import", "tsx", CLI, "modules", "uninstall", FIXTURE_ID, "--purge"], appEnv);
    assert.equal(removed.code, 0, removed.output);
    assert.equal((await db!.query("select 1 from core.files where module_id = $1", [FIXTURE_ID])).rowCount, 0, "its files are gone");
    assert.equal(existsSync(join(dataDir, "files", FIXTURE_ID)), false, "and their bytes");
    assert.equal((await db!.query("select 1 from core.module_settings where module_id = $1", [FIXTURE_ID])).rowCount, 0);
    assert.equal((await db!.query("select 1 from core.service_tokens where module_id = $1", [FIXTURE_ID])).rowCount, 0, "its tokens go with it");
    assert.equal((await db!.query("select 1 from core.jobs where module_id = $1", [FIXTURE_ID])).rowCount, 0, "and its jobs");
    assert.ok(((await db!.query("select 1 from core.service_token_events where module_id = $1", [FIXTURE_ID])).rowCount ?? 0) > 0, "and their trail stays");
    assert.equal((await db!.query("select 1 from core.platform_settings where key like $1", [`appearance.module.${FIXTURE_ID}.%`])).rowCount, 0);
    assert.ok(((await db!.query("select 1 from core.settings_events where scope = $1", [FIXTURE_ID])).rowCount ?? 0) > 0, "the trail outlives the data");

    // The running build still has the module in its registry until it is rebuilt; the database says it is gone,
    // and a write must not bring its rows back.
    for (const [path, body] of [
      [`/api/settings/modules/${FIXTURE_ID}`, { values: { "site.title": "Zombie" } }],
      [`/api/settings/modules/${FIXTURE_ID}/appearance`, { accentHue: 99 }],
    ] as const) {
      assert.equal((await put(path, body, { cookie })).status, 404, path);
    }
    assert.equal((await db!.query("select 1 from core.module_settings where module_id = $1", [FIXTURE_ID])).rowCount, 0);
    assert.equal((await db!.query("select 1 from core.platform_settings where key like $1", [`appearance.module.${FIXTURE_ID}.%`])).rowCount, 0);
    assert.doesNotMatch(html(await call("GET", "/settings", { cookie })), /E2E Fixture/, "and the screen stops listing it");
  });

  test("stops within the grace period on SIGTERM and frees the port", async () => {
    const stopped = await stopServer();
    assert.notEqual(stopped.code, "timeout", "the server did not stop");
    assert.equal(stopped.code, 0);
    assert.ok(stopped.ms < 9_000, `took ${stopped.ms} ms`);
    await assert.rejects(call("GET", "/login"));
  });
});
