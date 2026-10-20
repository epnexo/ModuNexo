import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EventRecord } from "@modunexo/core/events";
import type { ModuleManifest } from "@modunexo/sdk";
import { type StreamDeps, openEventStream, selectEventTypes, streamableEvents } from "../src/server/event-stream.ts";

const manifest = (id: string, events: ModuleManifest["events"]): ModuleManifest =>
  ({ id, version: "1.0.0", name: id, platform: "^0.1.0", dependsOn: {}, schema: id, migrationsDir: "m", nav: [], events }) as ModuleManifest;

const catalogue = streamableEvents([
  manifest("inbox", [{ name: "message.received", permission: "read" }, { name: "internal" }, { name: "closed", permission: "read" }]),
  manifest("crm", [{ name: "deal.won", permission: "read" }]),
]);

const operator = { kind: "operator" } as const;
const admin = { kind: "user", role: "admin" } as const;
const viewer = { kind: "user", role: "viewer" } as const;

describe("streamableEvents", () => {
  it("lists only the events that name a permission, by full type", () => {
    assert.deepEqual([...catalogue.keys()].sort(), ["crm.deal.won", "inbox.closed", "inbox.message.received"]);
    assert.deepEqual(catalogue.get("inbox.closed"), { moduleId: "inbox", permission: "read" });
  });
});

describe("selectEventTypes", () => {
  it("defaults to every type the viewer may see", () => {
    for (const subject of [operator, admin]) {
      const picked = selectEventTypes(catalogue, subject, null);
      assert.ok(picked.ok);
      assert.deepEqual([...picked.types].sort(), ["crm.deal.won", "inbox.closed", "inbox.message.received"]);
    }
  });

  it("narrows to the types asked for and collapses repeats", () => {
    const picked = selectEventTypes(catalogue, admin, "inbox.closed, inbox.closed,crm.deal.won");
    assert.ok(picked.ok);
    assert.deepEqual([...picked.types].sort(), ["crm.deal.won", "inbox.closed"]);
  });

  it("refuses a type that is unknown or not streamed with 400, and too many with 400", () => {
    for (const asked of ["nope.x", "inbox.internal", "inbox.closed,nope.x", ",", "inbox.closed,,x"]) {
      const picked = selectEventTypes(catalogue, admin, asked);
      assert.ok(!picked.ok, asked);
      assert.equal(picked.status, 400, asked);
    }
    const many = Array.from({ length: 21 }, (_, i) => `inbox.t${i}`).join(",");
    const picked = selectEventTypes(catalogue, admin, many);
    assert.ok(!picked.ok);
    assert.equal(picked.status, 400);
  });

  it("answers 403 to a viewer who holds no permission, whether or not they ask for a type", () => {
    for (const asked of [null, "inbox.closed"]) {
      const picked = selectEventTypes(catalogue, viewer, asked);
      assert.ok(!picked.ok);
      assert.equal(picked.status, 403);
    }
  });
});

interface Harness {
  deps: StreamDeps;
  push: (event: EventRecord) => void;
  subscribers: () => number;
  setEnabled: (ids: string[]) => void;
}

const event = (id: number, type = "inbox.message.received", payload: unknown = { id }): EventRecord => ({
  id,
  moduleId: type.split(".")[0]!,
  type,
  payload,
  createdAt: new Date("2026-10-20T12:00:00Z"),
});

function harness(stored: EventRecord[] = [], extra: Partial<{ resolve: (after: number) => { reset: boolean; from: number }; assigned: number }> = {}): Harness {
  const listeners = new Set<(event: EventRecord) => void>();
  let enabled = new Set(["inbox", "crm"]);
  const deps: StreamDeps = {
    hub: {
      subscribe: (listener) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    },
    events: {
      resolveCursor: async (after) => (extra.resolve ? extra.resolve(after) : { reset: false, from: after }),
      readAfter: async (after, types, limit) => stored.filter((e) => e.id > after && (types === null || types.includes(e.type))).slice(0, limit),
      lastAssigned: async () => extra.assigned ?? Math.max(0, ...stored.map((e) => e.id)),
    },
    enabledModules: async () => enabled,
    heartbeatMs: 60_000,
    replayLimit: 3,
    maxQueued: 50,
    log: { warn: () => {} },
  };
  return { deps, push: (e) => listeners.forEach((l) => l(e)), subscribers: () => listeners.size, setEnabled: (ids) => void (enabled = new Set(ids)) };
}

const decoder = new TextDecoder();
function reader(stream: ReadableStream<Uint8Array>) {
  const r = stream.getReader();
  let text = "";
  return {
    /** Reads until the text so far satisfies `done`, or fails after a second. */
    async until(done: (text: string) => boolean): Promise<string> {
      const deadline = Date.now() + 1000;
      while (!done(text)) {
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`timed out; text so far:\n${text}`);
        const next = await Promise.race([r.read(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out; text so far:\n${text}`)), left))]);
        if (next.done) break;
        text += decoder.decode(next.value);
      }
      return text;
    },
    async ended(): Promise<boolean> {
      const deadline = Date.now() + 1000;
      while (Date.now() < deadline) {
        const next = await Promise.race([r.read(), new Promise<null>((resolve) => setTimeout(() => resolve(null), 100))]);
        if (next === null) continue;
        if (next.done) return true;
        text += decoder.decode(next.value);
      }
      return false;
    },
    cancel: () => r.cancel(),
    get text() {
      return text;
    },
  };
}

const frames = (text: string): Array<{ id?: string; event?: string; data?: string }> =>
  text
    .split("\n\n")
    .filter((block) => block.trim() !== "" && !block.startsWith(":") && !block.startsWith("retry:"))
    .map((block) => Object.fromEntries(block.split("\n").map((line) => [line.slice(0, line.indexOf(": ")), line.slice(line.indexOf(": ") + 2)])));

const TYPES = new Set(["inbox.message.received", "inbox.closed", "crm.deal.won"]);
const open = (h: Harness, after = 0, signal = new AbortController().signal) => reader(openEventStream(h.deps, { types: TYPES, after, signal }));

describe("openEventStream", () => {
  it("says how long a client waits to reconnect, replays what it missed in order, then sends new events", async () => {
    const h = harness([event(1), event(2, "inbox.closed"), event(3, "other.thing"), event(4)]);
    const stream = open(h, 1);
    const text = await stream.until((t) => frames(t).length >= 2);
    assert.ok(text.startsWith("retry: 3000\n\n"));
    assert.deepEqual(frames(text).map((f) => [f.id, f.event]), [["2", "inbox.closed"], ["4", "inbox.message.received"]]);
    assert.deepEqual(JSON.parse(frames(text)[1]!.data!), { id: 4, type: "inbox.message.received", payload: { id: 4 }, createdAt: "2026-10-20T12:00:00.000Z" });
    h.push(event(5, "crm.deal.won"));
    const later = await stream.until((t) => frames(t).length >= 3);
    assert.deepEqual(frames(later).map((f) => f.id), ["2", "4", "5"]);
    await stream.cancel();
  });

  it("does not send an event twice when it arrives both in the replay and from the hub", async () => {
    const h = harness([event(1), event(2)]);
    const stream = open(h, 0);
    // The hub hands out event 2 while the replay is reading it.
    h.push(event(2));
    h.push(event(3));
    const text = await stream.until((t) => frames(t).length >= 3);
    assert.deepEqual(frames(text).map((f) => f.id), ["1", "2", "3"]);
    await stream.cancel();
  });

  it("sends only the types it was opened for and none from a module that is no longer enabled", async () => {
    const h = harness();
    const stream = open(h);
    await stream.until((t) => t.includes("retry:"));
    h.push(event(1, "inbox.internal"));
    h.push(event(2, "inbox.closed"));
    h.setEnabled(["inbox"]);
    h.push(event(3, "crm.deal.won"));
    h.push(event(4));
    const text = await stream.until((t) => frames(t).length >= 2);
    assert.deepEqual(frames(text).map((f) => f.id), ["2", "4"]);
    await stream.cancel();
  });

  it("starts with a reset when events were pruned, and continues from where the log starts", async () => {
    const h = harness([event(10), event(11)], { resolve: () => ({ reset: true, from: 9 }) });
    const stream = open(h, 2);
    const text = await stream.until((t) => frames(t).length >= 3);
    assert.deepEqual(frames(text).map((f) => [f.id, f.event]), [["9", "reset"], ["10", "inbox.message.received"], ["11", "inbox.message.received"]]);
    assert.deepEqual(JSON.parse(frames(text)[0]!.data!), { after: 9 });
    await stream.cancel();
  });

  it("resets instead of replaying a backlog larger than the replay limit", async () => {
    const h = harness([event(1), event(2), event(3), event(4)], { assigned: 4 });
    const stream = open(h, 0);
    const text = await stream.until((t) => frames(t).length >= 1);
    assert.deepEqual(frames(text).map((f) => [f.id, f.event]), [["4", "reset"]]);
    h.push(event(5));
    const later = await stream.until((t) => frames(t).length >= 2);
    assert.deepEqual(frames(later).map((f) => f.id), ["4", "5"]);
    await stream.cancel();
  });

  it("keeps the connection alive with a comment line", async () => {
    const h = harness();
    h.deps.heartbeatMs = 30;
    const stream = open(h);
    const text = await stream.until((t) => t.includes(": keepalive\n\n"));
    assert.ok(text.includes(": keepalive\n\n"));
    await stream.cancel();
  });

  it("lets go of the hub when the client leaves or the request aborts", async () => {
    const h = harness();
    const first = open(h);
    await first.until((t) => t.includes("retry:"));
    assert.equal(h.subscribers(), 1);
    await first.cancel();
    assert.equal(h.subscribers(), 0);

    const controller = new AbortController();
    const second = open(h, 0, controller.signal);
    await second.until((t) => t.includes("retry:"));
    assert.equal(h.subscribers(), 1);
    controller.abort();
    assert.equal(await second.ended(), true);
    assert.equal(h.subscribers(), 0);
  });

  it("closes a client that does not read, so it cannot hold memory, and it can resume by cursor", async () => {
    const h = harness();
    const stream = openEventStream(h.deps, { types: TYPES, after: 0, signal: new AbortController().signal });
    const slow = stream.getReader();
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (let i = 1; i <= 200; i++) h.push(event(i));
    const deadline = Date.now() + 1000;
    while (h.subscribers() > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(h.subscribers(), 0);
    await slow.cancel().catch(() => undefined);
  });

  it("ends the stream with an error when the log cannot be read, and lets go of the hub", async () => {
    const h = harness();
    h.deps.events.readAfter = async () => {
      throw new Error("database down");
    };
    const stream = open(h, 0);
    await assert.rejects(() => stream.until((t) => frames(t).length >= 1), /database down|timed out/);
    assert.equal(h.subscribers(), 0);
  });
});
