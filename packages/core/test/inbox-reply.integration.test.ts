import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import deliver from "../../../modules-src/inbox/jobs/deliver.ts";
import { DELIVER_ATTEMPTS } from "../../../modules-src/inbox/lib/limits.ts";
import inbox from "../../../modules-src/inbox/manifest.ts";
import { POST as reply } from "../../../modules-src/inbox/web/reply.ts";
import { registerModuleRuntime } from "../src/jobs/runtime.ts";
import { createPool } from "../src/pool.ts";
import { Registry } from "../src/registry.ts";
import { migrate } from "../src/runner.ts";
import { SettingsService } from "../src/settings/service.ts";
import { createScratchDatabase } from "../src/testing.ts";

const MODULE_DIR = fileURLToPath(new URL("../../../modules-src/inbox/", import.meta.url));
const KEY = "k".repeat(40);
const OUT_SECRET = "outbound-shared-secret";

let pool: pg.Pool | undefined;
let skipReason: string | undefined;
let dropScratch: (() => Promise<void>) | undefined;
let settings: SettingsService;
let server: Server;
let origin: string;
let seen: { headers: IncomingMessage["headers"]; body: string }[] = [];
let answer = 200;

before(async () => {
  process.env.MODUNEXO_MASTER_KEY = KEY;
  const scratch = await createScratchDatabase();
  if (!scratch.url) {
    skipReason = scratch.skipReason;
    return;
  }
  dropScratch = scratch.drop;
  pool = createPool(scratch.url);
  const registry = new Registry();
  registry.registerCore();
  registry.register(inbox);
  await migrate(pool, registry, { moduleDirs: { inbox: MODULE_DIR } });
  await pool.query("insert into core.modules (id, state, installed_version) values ('inbox', 'enabled', $1)", [inbox.version]);
  registerModuleRuntime(pool, { current: registry });
  settings = new SettingsService(pool, registry, { masterKey: KEY });
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      res.statusCode = answer;
      res.end("provider says no");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.close();
  await pool?.end();
  await dropScratch?.();
});

let conversation = 0;
beforeEach(async () => {
  if (skipReason) return;
  seen = [];
  answer = 200;
  for (const table of ["core.events", "core.jobs", "inbox.messages", "inbox.conversations", "inbox.contacts"]) await pool!.query(`delete from ${table}`);
  await settings.set("inbox", "outbound_url", `${origin}/in`, "test");
  await settings.set("inbox", "outbound_secret", OUT_SECRET, "test");
  const contact = await pool!.query("insert into inbox.contacts (channel, ref, name) values ('web', 'c-1', 'Ada') returning id");
  const made = await pool!.query("insert into inbox.conversations (channel, thread_ref, contact_id, unread_count) values ('web', 't-1', $1, 3) returning id", [contact.rows[0].id]);
  conversation = Number(made.rows[0].id);
});

const form = (fields: Record<string, string>, headers: Record<string, string> = { origin: "http://shell.test", host: "shell.test" }) =>
  new Request("http://shell.test/inbox/reply", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(fields).toString() });
const count = async (table: string) => Number((await pool!.query(`select count(*)::int as n from ${table}`)).rows[0].n);
const outbound = async () => (await pool!.query("select id, direction, text, status, error from inbox.messages where direction = 'out' order by id")).rows;
const ctx = (messageId: number, attempt = 1) => ({ moduleId: "inbox", jobName: "deliver", jobId: 1, attempt, payload: { messageId }, signal: new AbortController().signal });

describe("POST /inbox/reply", { concurrency: false }, () => {
  it("stores the reply as queued, enqueues its delivery and leaves the unread count alone", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const response = await reply(form({ conversationId: String(conversation), text: "  Hello Ada " }));
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), `/inbox?c=${conversation}`);
    const rows = await outbound();
    assert.deepEqual(rows.map((r) => [r.direction, r.text, r.status, r.error]), [["out", "Hello Ada", "queued", null]]);
    const jobs = (await pool!.query("select module_id, name, payload from core.jobs")).rows;
    assert.deepEqual(jobs, [{ module_id: "inbox", name: "deliver", payload: { messageId: Number(rows[0].id) } }]);
    assert.equal(Number((await pool!.query("select unread_count from inbox.conversations")).rows[0].unread_count), 3);
  });

  it("keeps the reply queued and enqueues nothing while no outbound URL is set", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await settings.unset("inbox", "outbound_url", "test");
    const response = await reply(form({ conversationId: String(conversation), text: "Hi" }));
    assert.equal(response.status, 303);
    assert.equal((await outbound()).length, 1);
    assert.equal(await count("core.jobs"), 0);
  });

  it("refuses another site, a request with no origin, an unknown conversation and a text it cannot use, and stores nothing", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const id = String(conversation);
    const cases: [Request, number][] = [
      [form({ conversationId: id, text: "x" }, { origin: "http://evil.test", host: "shell.test" }), 403],
      [form({ conversationId: id, text: "x" }, { host: "shell.test" }), 403],
      [form({ conversationId: "999999", text: "x" }), 404],
      [form({ conversationId: "abc", text: "x" }), 400],
      [form({ conversationId: id, text: "   " }), 400],
      [form({ conversationId: id, text: "x".repeat(4001) }), 400],
      [form({ conversationId: id, text: "a\u0000b" }), 400],
      [form({ text: "x" }), 400],
    ];
    for (const [request, status] of cases) assert.equal((await reply(request)).status, status);
    assert.equal((await outbound()).length, 0);
    assert.equal(await count("core.jobs"), 0);
  });
});

describe("the deliver job", { concurrency: false }, () => {
  const queue = async (text = "Hello Ada") => {
    const made = await pool!.query("insert into inbox.messages (conversation_id, channel, direction, text, status) values ($1, 'web', 'out', $2, 'queued') returning id", [conversation, text]);
    return Number(made.rows[0].id);
  };

  it("posts the reply to the outbound URL signed with the outbound secret, then marks it sent", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const id = await queue();
    await deliver(ctx(id));
    assert.equal(seen.length, 1);
    const call = seen[0]!;
    assert.equal(call.headers["x-signature"], `sha256=${createHmac("sha256", OUT_SECRET).update(call.body).digest("hex")}`);
    assert.deepEqual(JSON.parse(call.body), { channel: "web", threadRef: "t-1", messageId: String(id), text: "Hello Ada", contact: { ref: "c-1" } });
    assert.deepEqual((await outbound()).map((r) => [r.status, r.error]), [["sent", null]]);
  });

  it("does not send a reply twice", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const id = await queue();
    await deliver(ctx(id));
    await deliver(ctx(id, 2));
    assert.equal(seen.length, 1);
  });

  it("keeps the reply queued with the reason and throws so the platform tries again", async (t) => {
    if (skipReason) return t.skip(skipReason);
    answer = 500;
    const id = await queue();
    await assert.rejects(() => deliver(ctx(id)), /HTTP 500/);
    const [row] = await outbound();
    assert.deepEqual([row.status, row.error], ["queued", "HTTP 500"]);
  });

  it("marks the reply failed on the last attempt, and never writes the URL, the secret or the provider's answer", async (t) => {
    if (skipReason) return t.skip(skipReason);
    answer = 502;
    const id = await queue();
    await assert.rejects(() => deliver(ctx(id, DELIVER_ATTEMPTS)));
    const [row] = await outbound();
    assert.deepEqual([row.status, row.error], ["failed", "HTTP 502"]);
    assert.equal(`${row.error}`.includes(origin) || `${row.error}`.includes(OUT_SECRET) || `${row.error}`.includes("provider says no"), false);
  });

  it("fails at once, without sending, when there is no outbound secret", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await settings.unset("inbox", "outbound_secret", "test");
    const id = await queue();
    await deliver(ctx(id));
    assert.equal(seen.length, 0);
    const [row] = await outbound();
    assert.equal(row.status, "failed");
    assert.match(row.error, /outbound_secret/);
  });

  it("fails at once, without sending, when the outbound URL is not an http or https address", async (t) => {
    if (skipReason) return t.skip(skipReason);
    for (const url of ["data:text/plain,x", "file:///etc/passwd", "ftp://host/x", "not a url"]) {
      await pool!.query("delete from inbox.messages");
      await settings.set("inbox", "outbound_url", url, "test");
      const id = await queue();
      await deliver(ctx(id));
      const [row] = await outbound();
      assert.equal(row.status, "failed", url);
      assert.match(row.error, /http/, url);
      assert.equal(`${row.error}`.includes(url), false, url);
    }
    assert.equal(seen.length, 0);
  });

  it("leaves the reply queued, without error and without sending, when there is no outbound URL", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await settings.unset("inbox", "outbound_url", "test");
    const id = await queue();
    await deliver(ctx(id));
    assert.equal(seen.length, 0);
    assert.deepEqual((await outbound()).map((r) => [r.status, r.error]), [["queued", null]]);
  });

  it("ignores a job whose message is gone or is not a queued reply", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await deliver(ctx(987654));
    const incoming = await pool!.query("insert into inbox.messages (conversation_id, channel, direction, text, status) values ($1, 'web', 'in', 'hi', 'received') returning id", [conversation]);
    await deliver(ctx(Number(incoming.rows[0].id)));
    assert.equal(seen.length, 0);
  });
});
