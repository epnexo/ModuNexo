import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import { EventHub, EventService, type EventRecord } from "../src/events/index.ts";
import { migrate } from "../src/runner.ts";
import { createPool } from "../src/pool.ts";
import { createScratchDatabase } from "../src/testing.ts";
import { Sandbox } from "./sandbox.ts";

let pool: pg.Pool | undefined;
let skipReason: string | undefined;
let dropScratch: (() => Promise<void>) | undefined;
let box: Sandbox;
let moduleId: string;
let service: EventService;

before(async () => {
  const scratch = await createScratchDatabase();
  if (!scratch.url) {
    skipReason = scratch.skipReason;
    return;
  }
  dropScratch = scratch.drop;
  pool = createPool(scratch.url);
  box = new Sandbox(pool);
  const mod = box.add();
  mod.manifest.events = [{ name: "created" }];
  moduleId = mod.manifest.id;
  await migrate(pool, box.registry());
  await pool.query("insert into core.modules (id, state, installed_version) values ($1, 'enabled', '1.0.0')", [moduleId]);
  service = new EventService(pool, box.registry());
});

after(async () => {
  if (pool) {
    await pool.query("delete from core.events").catch(() => undefined);
    await box.cleanup().catch(() => undefined);
    await pool.end();
  }
  await dropScratch?.();
});

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const until = async (check: () => boolean, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return check();
};
const publish = (n: number) => service.publish(moduleId, "created", { n });

function collect(hub: EventHub): { seen: EventRecord[]; off: () => void } {
  const seen: EventRecord[] = [];
  const off = hub.subscribe((event) => void seen.push(event));
  return { seen, off };
}

describe("EventHub", { concurrency: false }, () => {
  it("hands subscribers the events published after it started, in order, as soon as the database announces them", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await publish(0);
    // A poll that would take a minute: only the announcement can explain a fast delivery.
    const hub = new EventHub(pool!, service, { pollMs: 60_000, log: silent });
    await hub.start();
    try {
      const { seen } = collect(hub);
      const ids = [(await publish(1)).id, (await publish(2)).id, (await publish(3)).id];
      assert.ok(await until(() => seen.length === 3), `seen ${seen.length}`);
      assert.deepEqual(seen.map((e) => e.id), ids);
      assert.deepEqual(seen.map((e) => e.payload), [{ n: 1 }, { n: 2 }, { n: 3 }]);
    } finally {
      await hub.stop();
    }
  });

  it("does not wait for a published event it was not told about: the poll finds it when the connection cannot listen", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const hub = new EventHub(pool!, service, {
      pollMs: 50,
      reconnectMs: 60_000,
      log: silent,
      createClient: () => {
        throw new Error("cannot open a listening connection");
      },
    });
    await hub.start();
    try {
      const { seen } = collect(hub);
      const { id } = await publish(4);
      assert.ok(await until(() => seen.length === 1));
      assert.equal(seen[0]!.id, id);
    } finally {
      await hub.stop();
    }
  });

  it("reconnects when its listening connection is cut and delivers what was published meanwhile", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const hub = new EventHub(pool!, service, { pollMs: 60_000, reconnectMs: 50, log: silent });
    await hub.start();
    try {
      const { seen } = collect(hub);
      const first = await publish(5);
      assert.ok(await until(() => seen.length === 1));
      await pool!.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = current_database() and query like 'listen %' and pid <> pg_backend_pid()");
      const second = await publish(6);
      assert.ok(await until(() => seen.length === 2), `seen ${seen.length}`);
      const third = await publish(7);
      assert.ok(await until(() => seen.length === 3), "announcements work again after the reconnect");
      assert.deepEqual(seen.map((e) => e.id), [first.id, second.id, third.id]);
    } finally {
      await hub.stop();
    }
  });

  it("keeps serving the others when one subscriber throws, and stops serving one that left", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const hub = new EventHub(pool!, service, { pollMs: 60_000, log: silent });
    await hub.start();
    try {
      hub.subscribe(() => {
        throw new Error("a broken subscriber");
      });
      const { seen, off } = collect(hub);
      await publish(8);
      assert.ok(await until(() => seen.length === 1));
      off();
      await publish(9);
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(seen.length, 1);
      assert.equal(hub.size, 1);
    } finally {
      await hub.stop();
    }
  });

  it("stops cleanly and delivers nothing afterwards", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const hub = new EventHub(pool!, service, { pollMs: 50, log: silent });
    await hub.start();
    const { seen } = collect(hub);
    await hub.stop();
    await hub.stop();
    await publish(10);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(seen.length, 0);
    assert.equal(hub.size, 0);
  });
});

describe("EventService.settledPosition", { concurrency: false }, () => {
  it("waits for a publisher that holds the log, so a position it returns is committed", async (t) => {
    if (skipReason) return t.skip(skipReason);
    const client = await pool!.connect();
    const tx = {
      query: async (sql: string, params: readonly unknown[] = []) => {
        const result = await client.query(sql, [...params]);
        return { rows: result.rows, rowCount: result.rowCount ?? 0 };
      },
    };
    try {
      await client.query("begin");
      const { id } = await service.publish(moduleId, "created", { held: true }, { tx });
      let settled: number | undefined;
      const waiting = service.settledPosition().then((position) => {
        settled = position;
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(settled, undefined, "still waiting while the publisher has not committed");
      await client.query("commit");
      await waiting;
      assert.equal(settled, id);
    } finally {
      client.release();
    }
  });
});
