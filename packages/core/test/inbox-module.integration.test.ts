import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { validateManifest } from "@modunexo/sdk";
import inbox from "../../../modules-src/inbox/manifest.ts";
import { POST as receive } from "../../../modules-src/inbox/web/messages.ts";
import { registerModuleRuntime } from "../src/jobs/runtime.ts";
import { createPool } from "../src/pool.ts";
import { Registry } from "../src/registry.ts";
import { migrate } from "../src/runner.ts";
import { createScratchDatabase } from "../src/testing.ts";

const MODULE_DIR = fileURLToPath(new URL("../../../modules-src/inbox/", import.meta.url));

let pool: pg.Pool | undefined;
let skipReason: string | undefined;
let dropScratch: (() => Promise<void>) | undefined;

before(async () => {
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
});

after(async () => {
  await pool?.end();
  await dropScratch?.();
});

const wipe = async () => {
  await pool!.query("delete from core.events");
  await pool!.query("delete from core.jobs");
  await pool!.query("delete from inbox.messages");
  await pool!.query("delete from inbox.conversations");
  await pool!.query("delete from inbox.contacts");
};
const count = async (table: string) => Number((await pool!.query(`select count(*)::int as n from ${table}`)).rows[0].n);

const post = (body: unknown) => receive(new Request("http://localhost/hooks/inbox/messages", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }));
const message = (over: Record<string, unknown> = {}) => ({ channel: "web", threadRef: "t-1", messageId: "m-1", text: "hello", contact: { ref: "c-1", name: "Ada" }, ...over });

describe("the inbox manifest", () => {
  it("is a valid manifest that opens one public route, signed with a secret setting", () => {
    const checked = validateManifest(inbox);
    const route = checked.pages?.find((page) => page.public !== undefined);
    assert.equal(route?.path, "/hooks/inbox/messages");
    assert.deepEqual(route?.methods, ["POST"]);
    assert.equal(checked.settings?.find((setting) => setting.key === route?.public?.signature.secret)?.type, "secret");
  });
});

describe("POST /hooks/inbox/messages", { concurrency: false }, () => {
  it("stores the contact, the conversation and the message, and announces it once", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    const response = await post(message());
    assert.equal(response.status, 200);
    const body = (await response.json()) as { ok: boolean; duplicate: boolean };
    assert.deepEqual(body, { ok: true, duplicate: false });
    const rows = (await pool!.query("select c.ref, c.name, v.channel, v.thread_ref, v.unread_count, m.direction, m.text, m.status, m.provider_message_id from inbox.messages m join inbox.conversations v on v.id = m.conversation_id join inbox.contacts c on c.id = v.contact_id")).rows;
    assert.deepEqual(rows, [{ ref: "c-1", name: "Ada", channel: "web", thread_ref: "t-1", unread_count: 1, direction: "in", text: "hello", status: "received", provider_message_id: "m-1" }]);
    const events = (await pool!.query("select type, payload from core.events")).rows;
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "inbox.message.received");
    assert.deepEqual(Object.keys(events[0].payload).sort(), ["channel", "conversationId", "messageId"]);
    assert.equal(JSON.stringify(events[0].payload).includes("hello"), false);
  });

  it("keeps one conversation per thread and counts what is unread", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    await post(message());
    await post(message({ messageId: "m-2", text: "again" }));
    await post(message({ messageId: "m-3", threadRef: "t-2", contact: { ref: "c-2" } }));
    assert.equal(await count("inbox.contacts"), 2);
    assert.deepEqual((await pool!.query("select thread_ref, unread_count from inbox.conversations order by thread_ref")).rows, [
      { thread_ref: "t-1", unread_count: 2 },
      { thread_ref: "t-2", unread_count: 1 },
    ]);
  });

  it("accepts a delivery it already has without storing it or announcing it again", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    await post(message());
    const again = await post(message({ text: "changed" }));
    assert.equal(again.status, 200);
    assert.deepEqual(await again.json(), { ok: true, duplicate: true });
    assert.equal(await count("inbox.messages"), 1);
    assert.equal(await count("core.events"), 1);
    assert.deepEqual((await pool!.query("select text from inbox.messages")).rows, [{ text: "hello" }]);
    assert.equal(Number((await pool!.query("select unread_count from inbox.conversations")).rows[0].unread_count), 1);
  });

  it("stores a message once when the same delivery arrives twice at the same time", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    const answers = await Promise.all([post(message()), post(message())]);
    assert.deepEqual(answers.map((a) => a.status), [200, 200]);
    assert.equal(await count("inbox.messages"), 1);
    assert.equal(await count("core.events"), 1);
  });

  it("treats the same message id on another channel as another message", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    await post(message());
    await post(message({ channel: "sms" }));
    assert.equal(await count("inbox.messages"), 2);
  });

  it("refuses a body it cannot use with 400 and stores nothing", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    const bad: unknown[] = [
      "not json",
      "[]",
      "null",
      message({ text: "" }),
      message({ text: "   " }),
      message({ text: "x".repeat(4001) }),
      message({ channel: "" }),
      message({ channel: "Has Space" }),
      message({ threadRef: "" }),
      message({ messageId: 7 }),
      message({ contact: "Ada" }),
      message({ contact: { ref: "" } }),
      message({ contact: { ref: "c-1", name: 5 } }),
      message({ text: "a\u0000b" }),
      message({ threadRef: "t\u0000" }),
      message({ messageId: "\u0000" }),
      message({ contact: { ref: "c\u0000" } }),
      message({ contact: { ref: "c-1", name: "A\u0000" } }),
    ];
    for (const body of bad) {
      const response = await post(body);
      assert.equal(response.status, 400, JSON.stringify(body).slice(0, 60));
      const answer = (await response.json()) as { error: string };
      assert.equal(typeof answer.error, "string");
    }
    assert.equal(await count("inbox.messages") + (await count("inbox.contacts")) + (await count("core.events")), 0);
  });

  it("works without a contact, naming the conversation after its thread", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    const response = await post({ channel: "web", threadRef: "t-9", messageId: "m-9", text: "hi" });
    assert.equal(response.status, 200);
    assert.deepEqual((await pool!.query("select ref, name from inbox.contacts")).rows, [{ ref: "t-9", name: null }]);
  });

  it("does not write the text of a message to the log", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    const written: string[] = [];
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const originals = methods.map((name) => console[name]);
    for (const name of methods) console[name] = (...args: unknown[]) => void written.push(args.map(String).join(" "));
    try {
      await post(message({ text: "secret sentence" }));
      await post(message({ text: "" }));
    } finally {
      methods.forEach((name, index) => (console[name] = originals[index]!));
    }
    assert.equal(written.some((line) => line.includes("secret sentence")), false);
  });
});
