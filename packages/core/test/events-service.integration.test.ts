import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import type { DbQueryable } from "@modunexo/sdk";
import { EVENTS_CHANNEL, EventError, EventService, MAX_EVENT_PAYLOAD_BYTES } from "../src/events/index.ts";
import type { Registry } from "../src/registry.ts";
import { migrate } from "../src/runner.ts";
import { createPool } from "../src/pool.ts";
import { createScratchDatabase } from "../src/testing.ts";
import { Sandbox } from "./sandbox.ts";

let pool: pg.Pool | undefined;
let url: string;
let skipReason: string | undefined;
let dropScratch: (() => Promise<void>) | undefined;
let box: Sandbox;
let pubId: string;
let subId: string;
let offId: string;
let clock = new Date("2026-10-20T12:00:00Z");
let service: EventService;

before(async () => {
  const scratch = await createScratchDatabase();
  if (!scratch.url) {
    skipReason = scratch.skipReason;
    return;
  }
  dropScratch = scratch.drop;
  url = scratch.url;
  pool = createPool(url);
  box = new Sandbox(pool);
  const pub = box.add();
  pubId = pub.manifest.id;
  pub.manifest.permissions = [{ key: "read", label: "Read" }];
  pub.manifest.events = [{ name: "created" }, { name: "closed", permission: "read" }, { name: "ticket.updated" }];
  const subscription = [{ event: `${pubId}.created`, job: "on_created" }];
  const sub = box.add({ [pubId]: "^1.0.0" });
  subId = sub.manifest.id;
  sub.manifest.jobs = [{ name: "on_created", entry: "./jobs/on_created.ts" }];
  sub.manifest.subscriptions = subscription;
  const off = box.add({ [pubId]: "^1.0.0" });
  offId = off.manifest.id;
  off.manifest.jobs = [{ name: "on_created", entry: "./jobs/on_created.ts" }];
  off.manifest.subscriptions = subscription;
  await migrate(pool, box.registry());
  service = new EventService(pool, box.registry(), { now: () => clock });
});

const ids = () => [pubId, subId, offId];
const wipe = async () => {
  await pool!.query("delete from core.events");
  await pool!.query("delete from core.jobs");
  await pool!.query("delete from core.modules where id = any($1)", [ids()]);
  for (const [id, state] of [[pubId, "enabled"], [subId, "enabled"], [offId, "disabled"]]) {
    await pool!.query("insert into core.modules (id, state, installed_version) values ($1, $2, '1.0.0')", [id, state]);
  }
};
const count = async (table: string) => Number((await pool!.query(`select count(*)::int as n from core.${table}`)).rows[0].n);

after(async () => {
  if (pool) {
    await pool.query("delete from core.events").catch(() => undefined);
    await pool.query("delete from core.jobs").catch(() => undefined);
    await box.cleanup().catch(() => undefined);
    await pool.end();
  }
  await dropScratch?.();
});

describe("EventService.publish", { concurrency: false }, () => {
  it("stores the event and returns its position, which only grows", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    const first = await service.publish(pubId, "created", { ticket: 1 });
    const second = await service.publish(pubId, "ticket.updated", undefined);
    assert.ok(second.id > first.id);
    const rows = (await pool!.query("select id, module_id, type, payload, created_at from core.events order by id")).rows;
    assert.deepEqual(rows.map((r) => [Number(r.id), r.module_id, r.type, r.payload]), [
      [first.id, pubId, `${pubId}.created`, { ticket: 1 }],
      [second.id, pubId, `${pubId}.ticket.updated`, null],
    ]);
  });

  it("refuses an unknown module, an undeclared name and a module that is not enabled, and stores nothing", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    await assert.rejects(() => service.publish("nobody", "created", null), (e) => e instanceof EventError && /not registered/.test(e.message));
    await assert.rejects(() => service.publish(pubId, "nope", null), (e) => e instanceof EventError && /does not declare the event "nope"/.test(e.message) && e.message.includes("created"));
    await pool!.query("update core.modules set state = 'disabled' where id = $1", [pubId]);
    await assert.rejects(() => service.publish(pubId, "created", null), (e) => e instanceof EventError && /not enabled/.test(e.message));
    assert.equal(await count("events"), 0);
    assert.equal(await count("jobs"), 0);
  });

  it("refuses a payload that is not JSON, over 16 KiB, or holds a NUL character, and stores nothing", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    await assert.rejects(() => service.publish(pubId, "created", loop), /must be JSON/);
    await assert.rejects(() => service.publish(pubId, "created", "x".repeat(MAX_EVENT_PAYLOAD_BYTES)), /over 16 KiB/);
    await assert.rejects(() => service.publish(pubId, "created", { a: "bad\u0000text" }), /\\u0000/);
    assert.equal(await count("events"), 0);
    // A string that merely contains a backslash and the text u0000 is fine.
    await service.publish(pubId, "created", { a: "back\\u0000slash" });
    assert.equal(await count("events"), 1);
  });

  it("refuses an event whose full type is too long to store, before touching the caller's transaction", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    // A registry that has not validated its manifests, which would refuse a name this long.
    const long = { id: pubId, events: [{ name: "x".repeat(200) }] };
    const lenient = { get: () => long, all: () => [] } as unknown as Registry;
    await assert.rejects(() => new EventService(pool!, lenient).publish(pubId, "x".repeat(200), null), (e) => e instanceof EventError && /over 200 characters/.test(e.message));
    assert.equal(await count("events"), 0);
  });

  it("starts a job for every enabled subscriber and none for a disabled one or another event", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    const { id } = await service.publish(pubId, "created", { ticket: 7 });
    await service.publish(pubId, "ticket.updated", { ticket: 7 });
    const jobs = (await pool!.query("select module_id, name, payload, enqueued_by, status from core.jobs order by id")).rows;
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].module_id, subId);
    assert.equal(jobs[0].name, "on_created");
    assert.equal(jobs[0].status, "queued");
    assert.equal(jobs[0].enqueued_by, `event:${pubId}`);
    assert.deepEqual(jobs[0].payload, { event: { id, type: `${pubId}.created`, payload: { ticket: 7 }, createdAt: clock.toISOString() } });
  });

  it("writes in the caller's transaction: a rollback leaves no event and no job, a commit leaves both", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    const client = await pool!.connect();
    const tx: DbQueryable = {
      query: async (sql, params = []) => {
        const result = await client.query(sql, [...params]);
        return { rows: result.rows, rowCount: result.rowCount ?? 0 };
      },
    };
    try {
      await client.query("begin");
      await service.publish(pubId, "created", { n: 1 }, { tx });
      assert.equal(await count("events"), 0, "invisible to other connections before commit");
      await client.query("rollback");
      assert.equal(await count("events"), 0);
      assert.equal(await count("jobs"), 0);

      await client.query("begin");
      await service.publish(pubId, "created", { n: 2 }, { tx });
      await client.query("commit");
      assert.equal(await count("events"), 1);
      assert.equal(await count("jobs"), 1);
    } finally {
      client.release();
    }
  });

  it("announces on the channel only after the transaction commits", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    const listener = new pg.Client({ connectionString: url });
    await listener.connect();
    const heard: string[] = [];
    listener.on("notification", (message) => heard.push(`${message.channel}:${message.payload}`));
    await listener.query(`listen ${EVENTS_CHANNEL}`);
    const client = await pool!.connect();
    const tx: DbQueryable = {
      query: async (sql, params = []) => {
        const result = await client.query(sql, [...params]);
        return { rows: result.rows, rowCount: result.rowCount ?? 0 };
      },
    };
    try {
      await client.query("begin");
      const { id } = await service.publish(pubId, "created", null, { tx });
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.deepEqual(heard, [], "nothing before commit");
      await client.query("commit");
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.deepEqual(heard, [`${EVENTS_CHANNEL}:${id}`]);
    } finally {
      client.release();
      await listener.end();
    }
  });

  it("never lets a later position become visible before an earlier one, however many publish at once", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    let done = false;
    const snapshots: number[][] = [];
    const watcher = (async () => {
      while (!done) {
        const rows = (await pool!.query("select id from core.events order by id")).rows;
        snapshots.push(rows.map((r) => Number(r.id)));
      }
    })();
    await Promise.all(Array.from({ length: 40 }, () => service.publish(pubId, "ticket.updated", null)));
    done = true;
    await watcher;
    assert.equal(await count("events"), 40);
    for (const seen of snapshots) {
      if (seen.length === 0) continue;
      assert.equal(seen[seen.length - 1]! - seen[0]! + 1, seen.length, `a snapshot with a hole: ${seen.join(",")}`);
    }
  });
});

describe("EventService.readAfter and resolveCursor", { concurrency: false }, () => {
  it("reads events after a position in order, filtered by type and cut at the limit", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    const a = await service.publish(pubId, "created", { n: 1 });
    const b = await service.publish(pubId, "closed", { n: 2 });
    const c = await service.publish(pubId, "created", { n: 3 });
    const all = await service.readAfter(0, null, 10);
    assert.deepEqual(all.map((e) => e.id), [a.id, b.id, c.id]);
    assert.deepEqual(all[1], { id: b.id, moduleId: pubId, type: `${pubId}.closed`, payload: { n: 2 }, createdAt: clock });
    assert.deepEqual((await service.readAfter(a.id, null, 10)).map((e) => e.id), [b.id, c.id]);
    assert.deepEqual((await service.readAfter(0, [`${pubId}.created`], 10)).map((e) => e.id), [a.id, c.id]);
    assert.deepEqual((await service.readAfter(0, [], 10)).map((e) => e.id), []);
    assert.deepEqual((await service.readAfter(0, null, 2)).map((e) => e.id), [a.id, b.id]);
  });

  it("says where a stream may resume: from the cursor, or from the start of what is kept", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    const a = await service.publish(pubId, "created", null);
    const b = await service.publish(pubId, "created", null);
    assert.deepEqual(await service.resolveCursor(0), { reset: false, from: 0 });
    assert.deepEqual(await service.resolveCursor(a.id), { reset: false, from: a.id });
    assert.deepEqual(await service.resolveCursor(b.id), { reset: false, from: b.id });
    // Ahead of everything ever assigned: the cursor belongs to another database.
    assert.deepEqual(await service.resolveCursor(b.id + 1000), { reset: true, from: b.id });
    // Older than the oldest kept event.
    await pool!.query("delete from core.events where id = $1", [a.id]);
    const c = await service.publish(pubId, "created", null);
    await pool!.query("delete from core.events where id = $1", [b.id]);
    assert.deepEqual(await service.resolveCursor(a.id - 1), { reset: true, from: c.id - 1 });
    // Everything was pruned: a client that has not seen the last event missed it.
    await pool!.query("delete from core.events");
    assert.deepEqual(await service.resolveCursor(a.id), { reset: true, from: c.id });
    assert.deepEqual(await service.resolveCursor(c.id), { reset: false, from: c.id });
  });
});

describe("EventService.list and prune", { concurrency: false }, () => {
  it("lists newest first, by module or type, without the payload unless asked", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    const a = await service.publish(pubId, "created", { secret: 1 });
    const b = await service.publish(pubId, "closed", null);
    const listed = await service.list({});
    assert.deepEqual(listed.map((e) => e.id), [b.id, a.id]);
    assert.ok(listed.every((e) => !("payload" in e)));
    assert.deepEqual((await service.list({ type: `${pubId}.created` })).map((e) => e.id), [a.id]);
    assert.deepEqual((await service.list({ moduleId: "other" })).map((e) => e.id), []);
    assert.deepEqual((await service.list({ limit: 1 })).map((e) => e.id), [b.id]);
    assert.deepEqual((await service.list({ withPayload: true }))[1]!.payload, { secret: 1 });
  });

  it("prunes events older than seven days and keeps the rest", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    const old = await service.publish(pubId, "created", null);
    await pool!.query("update core.events set created_at = $2 where id = $1", [old.id, new Date(clock.getTime() - 8 * 86_400_000)]);
    const recent = await service.publish(pubId, "created", null);
    await pool!.query("update core.events set created_at = $2 where id = $1", [recent.id, new Date(clock.getTime() - 6 * 86_400_000)]);
    assert.equal(await service.prune(), 1);
    assert.deepEqual((await service.readAfter(0, null, 10)).map((e) => e.id), [recent.id]);
  });
});
