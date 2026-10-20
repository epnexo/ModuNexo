import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { EVENTS_PUBLISHER, EventsUnavailableError, type EventsPublisher, ManifestError, eventType, publishEvent, validateManifest } from "../src/index.ts";

const base = {
  id: "inbox",
  version: "1.0.0",
  name: "Inbox",
  platform: "^0.1.0",
  dependsOn: {},
  schema: "inbox",
  migrationsDir: "migrations",
  nav: [],
};

const problemsOf = (input: unknown): string[] => {
  try {
    validateManifest(input);
  } catch (error) {
    assert.ok(error instanceof ManifestError);
    return error.problems;
  }
  return [];
};

describe("eventType", () => {
  it("joins the module id and the event name", () => {
    assert.equal(eventType("inbox", "message.received"), "inbox.message.received");
  });
});

describe("validateManifest: events", () => {
  const withEvents = (events: unknown, extra: Record<string, unknown> = {}) => ({ ...base, ...extra, events });
  const event = (extra: Record<string, unknown> = {}) => ({ name: "message.received", ...extra });

  it("accepts no events, a plain event and one tied to a declared permission", () => {
    assert.deepEqual(problemsOf(base), []);
    assert.deepEqual(problemsOf(withEvents([event()])), []);
    assert.deepEqual(problemsOf(withEvents([event({ permission: "inbox.read" }), event({ name: "closed" })], { permissions: [{ key: "inbox.read", label: "Read" }] })), []);
  });

  it("requires an array of objects", () => {
    for (const events of ["message", {}, [null], ["message"], 1]) {
      assert.ok(problemsOf(withEvents(events)).some((p) => p.startsWith("events")), JSON.stringify(events));
    }
  });

  it("requires a stable name, unique in the module", () => {
    for (const name of ["", "Bad Name", "UPPER", "1x", undefined, 5, "a b", "a..b", ".a", "a."]) {
      assert.ok(problemsOf(withEvents([event({ name })])).some((p) => p.includes("events[0].name")), String(name));
    }
    assert.ok(problemsOf(withEvents([event(), event()])).some((p) => p.includes("duplicated")));
  });

  it("refuses a permission the module does not declare", () => {
    assert.ok(problemsOf(withEvents([event({ permission: "inbox.read" })])).some((p) => p.includes("events[0].permission")));
    assert.ok(problemsOf(withEvents([event({ permission: 5 })], { permissions: [{ key: "inbox.read", label: "Read" }] })).some((p) => p.includes("events[0].permission")));
  });

  it("refuses unknown fields", () => {
    assert.ok(problemsOf(withEvents([event({ stream: true })])).some((p) => p.includes('unknown field "stream"')));
  });
});

describe("validateManifest: subscriptions", () => {
  const sub = (extra: Record<string, unknown> = {}) => ({ event: "inbox.message.received", job: "handle", ...extra });
  const job = { name: "handle", entry: "./jobs/handle.ts" };
  const agent = (subscriptions: unknown, extra: Record<string, unknown> = {}) => ({
    ...base,
    id: "agent",
    schema: "agent",
    dependsOn: { inbox: "^1.0.0" },
    jobs: [job],
    ...extra,
    subscriptions,
  });

  it("accepts an event of a module in dependsOn, and an event of the module itself", () => {
    assert.deepEqual(problemsOf(agent([sub()])), []);
    assert.deepEqual(problemsOf(agent([sub({ event: "agent.reply.sent" })])), []);
    assert.deepEqual(problemsOf(agent([sub(), sub({ job: "other" })], { jobs: [job, { name: "other", entry: "./jobs/other.ts" }] })), []);
  });

  it("requires an array of objects", () => {
    for (const subscriptions of ["inbox.message", {}, [null], ["x"], 1]) {
      assert.ok(problemsOf(agent(subscriptions)).some((p) => p.startsWith("subscriptions")), JSON.stringify(subscriptions));
    }
  });

  it("requires a full event type", () => {
    for (const event of ["", "message", "inbox", "inbox.", "Inbox.message", ".message", "inbox..x", undefined, 5]) {
      assert.ok(problemsOf(agent([sub({ event })])).some((p) => p.includes("subscriptions[0].event")), String(event));
    }
  });

  it("refuses an event of a module that is not in dependsOn", () => {
    const problems = problemsOf(agent([sub({ event: "billing.invoice.paid" })]));
    assert.ok(problems.some((p) => p.includes("subscriptions[0].event") && p.includes("dependsOn")), problems.join("\n"));
  });

  it("requires a job the module declares", () => {
    for (const job of ["missing", "", undefined, 5]) {
      assert.ok(problemsOf(agent([sub({ job })])).some((p) => p.includes("subscriptions[0].job")), String(job));
    }
    assert.ok(problemsOf(agent([sub()], { jobs: undefined })).some((p) => p.includes("subscriptions[0].job")));
  });

  it("refuses the same event and job twice and unknown fields", () => {
    assert.ok(problemsOf(agent([sub(), sub()])).some((p) => p.includes("duplicated")));
    assert.ok(problemsOf(agent([sub({ filter: "x" })])).some((p) => p.includes('unknown field "filter"')));
  });
});

describe("publishEvent", () => {
  const slot = globalThis as typeof globalThis & { [EVENTS_PUBLISHER]?: EventsPublisher };
  afterEach(() => {
    delete slot[EVENTS_PUBLISHER];
  });

  it("fails clearly where the platform registered no publisher", async () => {
    await assert.rejects(() => publishEvent("inbox", "message.received", { id: 1 }), EventsUnavailableError);
  });

  it("hands the module, name, payload and options to the registered publisher", async () => {
    const calls: unknown[][] = [];
    slot[EVENTS_PUBLISHER] = {
      publish: async (...args) => {
        calls.push(args);
        return { id: 7 };
      },
    };
    const tx = { query: async () => ({ rows: [], rowCount: 0 }) };
    assert.deepEqual(await publishEvent("inbox", "message.received", { id: 1 }, { tx }), { id: 7 });
    assert.deepEqual(await publishEvent("inbox", "closed"), { id: 7 });
    assert.deepEqual(calls[0], ["inbox", "message.received", { id: 1 }, { tx }]);
    assert.deepEqual(calls[1], ["inbox", "closed", null, {}]);
  });
});
