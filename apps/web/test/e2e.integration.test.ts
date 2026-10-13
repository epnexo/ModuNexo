// End to end: the production build, served by the platform's own server, against a scratch database. This is the
// proof that the gate, the stamped connection address and the cookies behave on real requests; the pure pieces are
// tested on their own in the other files. It builds the app (several seconds) and is skipped when no test database
// is reachable.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { createAdministrator, createAuth, setSignInMode } from "@epnexo/core/auth";
import { createPool } from "@epnexo/core/pool";
import { Registry, migrate } from "@epnexo/core";
import { createScratchDatabase } from "@epnexo/core/testing";
import type pg from "pg";

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

const origin = () => `http://127.0.0.1:${port}`;
const signIn = (password: string, extra: Record<string, string> = {}) =>
  call("POST", "/api/auth/sign-in/email", { origin: origin(), ...extra }, { email: EMAIL, password });
const cookieOf = (reply: Reply) => {
  const lines = ([] as string[]).concat(reply.headers["set-cookie"] ?? []);
  return lines.map((line) => line.split(";")[0]).join("; ");
};
const location = (reply: Reply) => (reply.headers.location === undefined ? "" : new URL(String(reply.headers.location), origin()).pathname);

let appEnv: Record<string, string> = {};

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

before(async () => {
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

  port = await freePort();
  appEnv = { DATABASE_URL: scratchUrl, EPNEXO_MASTER_KEY: MASTER_KEY, WEB_HOST: "127.0.0.1", WEB_PORT: String(port), NODE_ENV: "production" };
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
  if (db !== undefined) {
    // The module's routes and registry entry were generated into the working tree; with the module gone from the
    // database and from disk, regenerating leaves the empty registry that a fresh checkout has.
    await run(["--import", "tsx", CLI, "registry:generate"], appEnv).catch(() => undefined);
  }
  await db?.end();
  await drop?.();
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
    for (const host of ["evil.example", `evil.example:${port}`, "epnexo.dev"]) {
      const reply = await call("GET", "/", { host });
      assert.equal(reply.status, 403, host);
      assert.equal(reply.body, "Forbidden");
    }
    assert.equal((await call("GET", "/", { host: `localhost:${port}` })).status, 200);
    assert.equal((await call("GET", "/", { host: `raspberrypi:${port}` })).status, 200);
  });

  test("believes the connection, not a client-written trusted header", async () => {
    assert.equal((await call("GET", "/", { "x-epnexo-client-ip": "8.8.8.8" })).status, 200);
    assert.equal((await call("GET", "/", { "x-epnexo-client-ip": "127.0.0.1", "x-forwarded-for": "8.8.8.8" })).status, 403);
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
    `import { SDK_VERSION, defineModule } from "@epnexo/sdk";
export default defineModule({
  id: "${FIXTURE_ID}",
  version: "1.0.0",
  name: "E2E Fixture",
  platform: \`^\${SDK_VERSION}\`,
  dependsOn: {},
  schema: "e2e_fixture",
  migrationsDir: "migrations",
  nav: [{ label: "Fixture", href: "/e2e-fixture", group: "Fixtures", order: 1, icon: "chart" }],
  pages: [{ path: "/e2e-fixture", entry: "./web/page.tsx", kind: "page" }],
  settings: [
    { key: "site.title", label: "Site title", type: "string", default: "Untitled" },
    { key: "page.size", label: "Page size", type: "number", default: 25 },
    { key: "report.format", label: "Report format", type: "select", options: ["pdf", "csv"], default: "pdf" },
    { key: "export.dir", label: "Export directory", type: "path", required: true },
    { key: "api.token", label: "API token", type: "secret", required: true },
  ],
});
`,
  );
  writeFileSync(join(FIXTURE_DIR, "migrations", "0001_init.sql"), "create table items (id int);");
  writeFileSync(
    join(FIXTURE_DIR, "web", "page.tsx"),
    `import { getSetting } from "@epnexo/sdk";
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
  // What `npm install` does for a workspace package: a link from node_modules to the package folder.
  mkdirSync(FIXTURE_SCOPE_DIR, { recursive: true });
  symlinkSync("../../modules/e2e-fixture", join(FIXTURE_SCOPE_DIR, "fixture"));
}

const put = (path: string, body: unknown, headers: Record<string, string> = {}) => call("PUT", path, { origin: origin(), ...headers }, body);
/** The page text as a reader sees it: React separates adjacent text nodes with `<!-- -->` markers in server HTML. */
const html = (reply: Reply) => reply.body.replace(/<!-- -->/g, "");

describe("web app: with a module installed", () => {
  let cookie = "";
  let userCookie = "";

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

  test("the settings screen shows the declared fields, the appearance, and what is still required", async () => {
    const page = await call("GET", "/settings", { cookie });
    assert.equal(page.status, 200);
    for (const text of ["Appearance", "E2E Fixture", "Site title", "Page size", "Report format", "Export directory", "API token", "2 required settings are not set"]) {
      assert.ok(html(page).includes(text), `expected "${text}" on the settings screen`);
    }
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

  test("uninstalling the module with purge removes its settings and its appearance, and keeps the audit trail", async () => {
    await put(`/api/settings/modules/${FIXTURE_ID}`, { values: { "site.title": "Again" } }, { cookie });
    await put(`/api/settings/modules/${FIXTURE_ID}/appearance`, { accentHue: 30 }, { cookie });
    const removed = await run(["--import", "tsx", CLI, "modules", "uninstall", FIXTURE_ID, "--purge"], appEnv);
    assert.equal(removed.code, 0, removed.output);
    assert.equal((await db!.query("select 1 from core.module_settings where module_id = $1", [FIXTURE_ID])).rowCount, 0);
    assert.equal((await db!.query("select 1 from core.platform_settings where key like $1", [`appearance.module.${FIXTURE_ID}.%`])).rowCount, 0);
    assert.ok(((await db!.query("select 1 from core.settings_events where scope = $1", [FIXTURE_ID])).rowCount ?? 0) > 0, "the trail outlives the data");
  });

  test("stops within the grace period on SIGTERM and frees the port", async () => {
    const stopped = await stopServer();
    assert.notEqual(stopped.code, "timeout", "the server did not stop");
    assert.equal(stopped.code, 0);
    assert.ok(stopped.ms < 9_000, `took ${stopped.ms} ms`);
    await assert.rejects(call("GET", "/login"));
  });
});
