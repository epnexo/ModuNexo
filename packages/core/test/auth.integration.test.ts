import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { getMigrations } from "better-auth/db/migration";
import type pg from "pg";
import { AdminRefusedError, PASSWORD_MIN_LENGTH, createAdministrator } from "../src/auth/admin.ts";
import { type Auth, createAuth } from "../src/auth/auth.ts";
import { Registry } from "../src/registry.ts";
import { migrate } from "../src/runner.ts";
import { openTestPool } from "../src/testing.ts";

let pool: pg.Pool | undefined;
let skipReason: string | undefined;
let auth: Auth;
const emails: string[] = [];
const PASSWORD = "correct horse battery";

before(async () => {
  ({ pool, skipReason } = await openTestPool());
  if (pool) {
    const registry = new Registry();
    registry.registerCore();
    await migrate(pool, registry);
    auth = createAuth({ pool, masterKey: "k".repeat(32), baseURL: "http://localhost:3000" });
  }
});

after(async () => {
  if (pool) {
    await pool.query('delete from core.auth_user where "email" = any($1)', [emails]);
    await pool.end();
  }
});

const test = (name: string, run: (email: string) => Promise<void>) =>
  it(name, async (t) => {
    if (!pool) return t.skip(skipReason);
    const email = `t-${randomBytes(4).toString("hex")}@example.test`;
    emails.push(email);
    await run(email);
  });

const userRows = async (email: string) => (await pool!.query('select * from core.auth_user where "email" = $1', [email])).rows;

describe("auth tables (migration 0003)", () => {
  test("match what the library expects: its own plan has nothing left to create or change", async () => {
    const plan = await getMigrations(auth.options, { throwOnUnsafe: false });
    assert.deepEqual(
      { create: plan.toBeCreated.map((t) => t.table), add: plan.toBeAdded.map((t) => t.table), indexes: plan.toBeAddedIndexes.map((i) => i.name), unsafe: plan.unsafeChanges, problems: plan.schemaProblems },
      { create: [], add: [], indexes: [], unsafe: [], problems: [] },
    );
  });

  test("live in the core schema and nowhere else", async () => {
    const { rows } = await pool!.query("select table_schema, table_name from information_schema.tables where table_name like 'auth\\_%' order by table_name");
    assert.deepEqual(
      rows.map((r) => `${r.table_schema}.${r.table_name}`),
      ["core.auth_account", "core.auth_rate_limit", "core.auth_session", "core.auth_user", "core.auth_verification"],
    );
  });
});

describe("createAdministrator", () => {
  test("creates a user with the admin role and a hashed password", async (email) => {
    const user = await createAdministrator(auth, { email, name: "Ada Admin", password: PASSWORD });
    assert.equal(user.email, email);

    const [row] = await userRows(email);
    assert.equal(row.role, "admin");
    assert.equal(row.name, "Ada Admin");
    const account = await pool!.query('select "providerId", "password" from core.auth_account where "userId" = $1', [row.id]);
    assert.equal(account.rows.length, 1);
    assert.equal(account.rows[0].providerId, "credential");
    assert.ok(account.rows[0].password.length > 40 && !account.rows[0].password.includes(PASSWORD), "the password is stored hashed");
  });

  test("lower-cases and trims the email", async (email) => {
    const user = await createAdministrator(auth, { email: `  ${email.toUpperCase()} `, name: "Ada", password: PASSWORD });
    assert.equal(user.email, email);
  });

  test("refuses an email that already exists and changes nothing", async (email) => {
    await createAdministrator(auth, { email, name: "First", password: PASSWORD });
    await assert.rejects(
      createAdministrator(auth, { email, name: "Second", password: "another long password" }),
      (error: unknown) => error instanceof AdminRefusedError && error.message.includes(email) && error.message.includes("already exists"),
    );
    const rows = await userRows(email);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, "First");
    const signedIn = await auth.api.signInEmail({ body: { email, password: PASSWORD } });
    assert.ok(signedIn.token, "the first password still works");
  });

  test(`refuses a password shorter than ${PASSWORD_MIN_LENGTH} characters and creates nothing`, async (email) => {
    await assert.rejects(
      createAdministrator(auth, { email, name: "Ada", password: "elevenchars" }),
      (error: unknown) => error instanceof AdminRefusedError && error.message.includes("at least 12 characters") && !error.message.includes("elevenchars"),
    );
    assert.equal((await userRows(email)).length, 0);
  });

  test("refuses a password longer than the library accepts and creates nothing", async (email) => {
    await assert.rejects(createAdministrator(auth, { email, name: "Ada", password: "p".repeat(129) }), AdminRefusedError);
    assert.equal((await userRows(email)).length, 0);
  });

  test("refuses a malformed email and a blank name", async (email) => {
    await assert.rejects(createAdministrator(auth, { email: "not-an-email", name: "Ada", password: PASSWORD }), AdminRefusedError);
    await assert.rejects(createAdministrator(auth, { email, name: "   ", password: PASSWORD }), AdminRefusedError);
    assert.equal((await userRows(email)).length, 0);
  });
});

/**
 * The web server sets this header from the connection and strips any copy a client sent (task T3). It is the only
 * header the limiter keys on; `x-forwarded-for` and friends are client-controlled and must never matter.
 */
const TRUSTED_IP_HEADER = "x-modunexo-client-ip";

describe("sign-in rate limit", () => {
  const attempt = (headers: Record<string, string>) =>
    auth.handler(
      new Request("http://localhost:3000/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3000", ...headers },
        body: JSON.stringify({ email: "nobody@example.test", password: "wrong password here" }),
      }),
    );
  const statuses = async (count: number, headers: (i: number) => Record<string, string>) => {
    const seen: number[] = [];
    for (let i = 0; i < count; i++) seen.push((await attempt(headers(i))).status);
    return seen;
  };

  test("a client cannot avoid the limit by rotating x-forwarded-for", async () => {
    await pool!.query("delete from core.auth_rate_limit");
    const seen = await statuses(8, (i) => ({ "x-forwarded-for": `10.9.9.${i}` }));
    assert.deepEqual(seen, [401, 401, 401, 401, 401, 429, 429, 429]);
  });

  test("throttles one trusted address without affecting another", async () => {
    await pool!.query("delete from core.auth_rate_limit");
    const first = await statuses(7, () => ({ [TRUSTED_IP_HEADER]: "192.0.2.10" }));
    assert.deepEqual(first, [401, 401, 401, 401, 401, 429, 429]);
    const other = await statuses(1, () => ({ [TRUSTED_IP_HEADER]: "192.0.2.11" }));
    assert.deepEqual(other, [401]);
  });

  test("the trusted header wins over a spoofed x-forwarded-for", async () => {
    await pool!.query("delete from core.auth_rate_limit");
    const seen = await statuses(6, (i) => ({ [TRUSTED_IP_HEADER]: "192.0.2.20", "x-forwarded-for": `10.8.8.${i}` }));
    assert.deepEqual(seen, [401, 401, 401, 401, 401, 429]);
  });
});

describe("same-origin check without a configured base URL", () => {
  // The web app is reached under whatever name the owner uses (an address, a host name), so no base URL is fixed:
  // a browser request is trusted when its Origin names the very host it was sent to.
  let open: Auth;
  before(() => {
    open = createAuth({ pool: pool!, masterKey: "k".repeat(32) });
  });
  const signIn = async (headers: Record<string, string>) => {
    await pool!.query("delete from core.auth_rate_limit");
    const response = await open.handler(
      new Request("http://localhost:3000/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json", "x-modunexo-client-ip": "192.0.2.77", ...headers },
        body: JSON.stringify({ email: "nobody@example.test", password: "wrong password here" }),
      }),
    );
    const body = (await response.json().catch(() => ({}))) as { code?: string };
    return `${response.status} ${body.code ?? ""}`.trim();
  };

  test("trusts an Origin that names the Host the request was sent to", async () => {
    assert.equal(await signIn({ host: "192.168.1.20:4000", origin: "http://192.168.1.20:4000" }), "401 INVALID_EMAIL_OR_PASSWORD");
    assert.equal(await signIn({ host: "modunexo.lan", origin: "https://modunexo.lan" }), "401 INVALID_EMAIL_OR_PASSWORD");
  });

  test("refuses an Origin that names another host", async () => {
    assert.equal(await signIn({ host: "192.168.1.20:4000", origin: "https://evil.example" }), "403 INVALID_ORIGIN");
    assert.equal(await signIn({ host: "192.168.1.20:4000", origin: "http://192.168.1.20:4001" }), "403 INVALID_ORIGIN");
  });

  test("does not let x-forwarded-host stand in for the Host header", async () => {
    assert.equal(await signIn({ host: "192.168.1.20:4000", origin: "https://evil.example", "x-forwarded-host": "evil.example" }), "403 INVALID_ORIGIN");
  });
});

describe("session cookie", () => {
  const cookieFor = async (secureCookies: boolean | undefined) => {
    const configured = createAuth({
      pool: pool!,
      masterKey: "k".repeat(32),
      baseURL: "http://localhost:3000",
      ...(secureCookies === undefined ? {} : { secureCookies }),
    });
    const email = `c-${randomBytes(4).toString("hex")}@example.test`;
    emails.push(email);
    await createAdministrator(configured, { email, name: "Ada", password: PASSWORD });
    const response = await configured.handler(
      new Request("http://localhost:3000/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3000", "x-modunexo-client-ip": `198.51.100.${Math.floor(Math.random() * 200) + 1}` },
        body: JSON.stringify({ email, password: PASSWORD }),
      }),
    );
    return response.headers.getSetCookie().join("\n");
  };

  test("is usable over plain HTTP by default", async () => {
    const cookie = await cookieFor(undefined);
    assert.match(cookie, /better-auth\.session_token=/);
    assert.doesNotMatch(cookie, /Secure/i);
    assert.doesNotMatch(cookie, /__Secure-/);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
  });

  test("is Secure and prefixed when the app is served over HTTPS", async () => {
    const cookie = await cookieFor(true);
    assert.match(cookie, /__Secure-better-auth\.session_token=/);
    assert.match(cookie, /Secure/);
  });
});

describe("sign-in", () => {
  test("accepts the right password and opens a session", async (email) => {
    await createAdministrator(auth, { email, name: "Ada", password: PASSWORD });
    const result = await auth.api.signInEmail({ body: { email, password: PASSWORD } });
    assert.ok(result.token);
    const sessions = await pool!.query('select "token" from core.auth_session where "userId" = $1', [result.user.id]);
    assert.equal(sessions.rows.length, 1);
  });

  test("refuses a wrong password and an unknown email with the same error", async (email) => {
    await createAdministrator(auth, { email, name: "Ada", password: PASSWORD });
    const failure = async (body: { email: string; password: string }) => {
      try {
        await auth.api.signInEmail({ body });
      } catch (error) {
        const e = error as { statusCode?: number; body?: { code?: string } };
        return `${e.statusCode} ${e.body?.code}`;
      }
      return "signed in";
    };
    const wrongPassword = await failure({ email, password: "wrong password here" });
    const unknownEmail = await failure({ email: `nobody-${email}`, password: PASSWORD });
    assert.equal(wrongPassword, "401 INVALID_EMAIL_OR_PASSWORD");
    assert.equal(unknownEmail, wrongPassword);
  });

  test("public sign-up is refused and creates no user", async (email) => {
    await assert.rejects(auth.api.signUpEmail({ body: { email, name: "Mallory", password: PASSWORD } }), (error: unknown) => (error as { body?: { code?: string } }).body?.code === "EMAIL_PASSWORD_SIGN_UP_DISABLED");
    assert.equal((await userRows(email)).length, 0);
  });
});
