// End to end: the production build, served by the platform's own server, against a scratch database. This is the
// proof that the gate, the stamped connection address and the cookies behave on real requests; the pure pieces are
// tested on their own in the other files. It builds the app (several seconds) and is skipped when no test database
// is reachable.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
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
  const env: Record<string, string> = { DATABASE_URL: scratchUrl, EPNEXO_MASTER_KEY: MASTER_KEY, WEB_HOST: "127.0.0.1", WEB_PORT: String(port), NODE_ENV: "production" };
  const built = await run(["--import", "tsx", `${WEB_ROOT}scripts/run.ts`, "build"], env);
  assert.equal(built.code, 0, `build failed:\n${built.output.slice(-2000)}`);

  const child = spawn(process.execPath, ["--import", "tsx", `${WEB_ROOT}scripts/run.ts`, "start"], { cwd: REPO_ROOT, env: childEnv(env), detached: true });
  server = child;
  child.stdout?.on("data", (chunk) => (serverOutput += chunk));
  child.stderr?.on("data", (chunk) => (serverOutput += chunk));
  const deadline = Date.now() + 60_000;
  while (!serverOutput.includes("listening on")) {
    if (Date.now() > deadline || child.exitCode !== null) assert.fail(`server did not start:\n${serverOutput.slice(-2000)}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
});

after(async () => {
  if (server?.pid !== undefined && server.exitCode === null) {
    try {
      process.kill(-server.pid, "SIGKILL");
    } catch {
      // already gone
    }
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

  test("stops within the grace period on SIGTERM and frees the port", async () => {
    assert.ok(server?.pid !== undefined);
    const exited = new Promise<number | null>((resolve) => server!.once("exit", (code) => resolve(code)));
    const started = Date.now();
    process.kill(-server!.pid!, "SIGTERM");
    const code = await Promise.race([exited, new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 12_000))]);
    assert.notEqual(code, "timeout", "the server did not stop");
    assert.equal(code, 0);
    assert.ok(Date.now() - started < 9_000, `took ${Date.now() - started} ms`);
    await assert.rejects(call("GET", "/login"));
  });
});
