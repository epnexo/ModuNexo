import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { listConversations, loadThread, markRead } from "../../../modules-src/inbox/lib/read.ts";
import inbox from "../../../modules-src/inbox/manifest.ts";
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

beforeEach(async () => {
  if (skipReason) return;
  for (const table of ["inbox.messages", "inbox.conversations", "inbox.contacts"]) await pool!.query(`delete from ${table}`);
});

/** A conversation with `texts` as its messages, oldest first; returns its id. */
async function conversation(thread: string, texts: string[], options: { name?: string | null; unread?: number; last?: string } = {}): Promise<number> {
  const contact = await pool!.query("insert into inbox.contacts (channel, ref, name) values ('web', $1, $2) returning id", [`c-${thread}`, options.name ?? null]);
  const made = await pool!.query("insert into inbox.conversations (channel, thread_ref, contact_id, unread_count, last_message_at) values ('web', $1, $2, $3, $4) returning id", [thread, contact.rows[0].id, options.unread ?? 0, options.last ?? "2026-10-21T10:00:00Z"]);
  const id = Number(made.rows[0].id);
  for (const [index, text] of texts.entries()) {
    await pool!.query("insert into inbox.messages (conversation_id, channel, direction, text, status) values ($1, 'web', $2, $3, $4)", [id, index % 2 === 0 ? "in" : "out", text, index % 2 === 0 ? "received" : "sent"]);
  }
  return id;
}

describe("listConversations", { concurrency: false }, () => {
  it("lists the newest activity first with the contact, the unread count and the last text", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await conversation("old", ["first"], { name: "Old", last: "2026-10-20T10:00:00Z" });
    await conversation("new", ["hi", "hello there"], { name: "New", unread: 2, last: "2026-10-21T11:00:00Z" });
    const rows = await listConversations();
    assert.deepEqual(rows.map((r) => [r.contactName, r.unread, r.lastText]), [["New", 2, "hello there"], ["Old", 0, "first"]]);
  });

  it("falls back to the contact's reference when it has no name, and returns at most 50", async (t) => {
    if (skipReason) return t.skip(skipReason);
    for (let index = 0; index < 52; index += 1) await conversation(`t-${index}`, ["x"], { last: new Date(Date.UTC(2026, 9, 21, 0, index)).toISOString() });
    const rows = await listConversations();
    assert.equal(rows.length, 50);
    assert.equal(rows[0]!.contactName, null);
    assert.equal(rows[0]!.contactRef, "c-t-51");
  });
});

describe("loadThread", { concurrency: false }, () => {
  it("returns the conversation and its messages oldest first, with the status of each", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const id = await conversation("t", ["one", "two", "three"], { name: "Ada" });
    const thread = await loadThread(id);
    assert.equal(thread?.conversation.contactName, "Ada");
    assert.deepEqual(thread?.messages.map((m) => [m.direction, m.text, m.status]), [["in", "one", "received"], ["out", "two", "sent"], ["in", "three", "received"]]);
  });

  it("returns the newest 200 messages when there are more", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const id = await conversation("long", []);
    await pool!.query("insert into inbox.messages (conversation_id, channel, direction, text, status) select $1, 'web', 'in', 'm' || n, 'received' from generate_series(1, 205) n", [id]);
    const thread = await loadThread(id);
    assert.equal(thread?.messages.length, 200);
    assert.equal(thread?.messages[0]!.text, "m6");
    assert.equal(thread?.messages[199]!.text, "m205");
  });

  it("returns null for a conversation that does not exist", async (t) => {
    if (skipReason) return t.skip(skipReason);
    assert.equal(await loadThread(424242), null);
  });
});

describe("markRead", { concurrency: false }, () => {
  it("clears the unread count of that conversation only", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const a = await conversation("a", ["x"], { unread: 4 });
    await conversation("b", ["y"], { unread: 2 });
    await markRead(a);
    assert.deepEqual((await pool!.query("select thread_ref, unread_count from inbox.conversations order by thread_ref")).rows, [
      { thread_ref: "a", unread_count: 0 },
      { thread_ref: "b", unread_count: 2 },
    ]);
  });
});
