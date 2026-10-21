import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LlmError } from "@modunexo/sdk";
import type { JobRecord } from "@modunexo/core/jobs";
import { ERROR_CHARS, cutText, formatAgo, formatBytes, formatWait, modelRows, probeError, probeSummary, runProbe, troubleRows, workerLine } from "../src/server/status.ts";

describe("cutText", () => {
  it("is null for nothing, and one tidy line for anything else", () => {
    assert.equal(cutText(null), null);
    assert.equal(cutText(""), null);
    assert.equal(cutText("   \n\t "), null);
    assert.equal(cutText("short"), "short");
    assert.equal(cutText("a\n  b\tc\r\nd"), "a b c d");
    assert.equal(cutText("bell\u0007and\u0000nul"), "bell and nul");
  });

  it("cuts a long text to 200 characters, ending in an ellipsis, without splitting a character", () => {
    const cut = cutText("x".repeat(500))!;
    assert.equal(cut.length, ERROR_CHARS);
    assert.ok(cut.endsWith("…"));
    const emoji = cutText("😀".repeat(500))!;
    assert.equal(Array.from(emoji).length, ERROR_CHARS);
    assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(emoji));
    assert.equal(cutText("y".repeat(200)), "y".repeat(200), "exactly 200 is kept whole");
  });
});

describe("formatBytes", () => {
  it("writes a size the way a person reads it", () => {
    assert.deepEqual([0, 1, 1023].map(formatBytes), ["0 B", "1 B", "1023 B"]);
    assert.deepEqual([1024, 1536, 15 * 1024, 1048576, 10 * 1048576].map(formatBytes), ["1.0 KB", "1.5 KB", "15 KB", "1.0 MB", "10 MB"]);
    assert.deepEqual([1073741824, 5 * 1099511627776].map(formatBytes), ["1.0 GB", "5.0 TB"]);
  });

  it("moves up a unit when rounding reaches the next one, instead of writing 1024 KB", () => {
    assert.deepEqual([1048575, 1024 * 1024 - 100, 1024 ** 3 - 1, 1024 ** 4 - 1].map(formatBytes), ["1.0 MB", "1.0 MB", "1.0 GB", "1.0 TB"]);
    assert.equal(formatBytes(1024 * 1023 + 100), "1023 KB", "and stays when it does not");
  });

  it("does not break on what is not a size", () => {
    for (const bad of [-5, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(formatBytes(bad), "0 B", String(bad));
  });
});

describe("formatWait and formatAgo", () => {
  it("names a wait in the largest unit that fits", () => {
    assert.deepEqual([0, 45, 59].map(formatWait), ["0 s", "45 s", "59 s"]);
    assert.deepEqual([60, 125, 3599].map(formatWait), ["1 min", "2 min", "59 min"]);
    assert.deepEqual([3600, 7300, 86399].map(formatWait), ["1 h", "2 h", "23 h"]);
    assert.deepEqual([86400, 200000].map(formatWait), ["1 d", "2 d"]);
  });

  it("reads what is not a number as no time at all", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -30]) assert.equal(formatWait(bad), "0 s", String(bad));
  });

  it("says how long ago something happened", () => {
    const now = new Date("2026-10-21T12:00:00Z");
    const ago = (seconds: number) => formatAgo(new Date(now.getTime() - seconds * 1000), now);
    assert.deepEqual([0, 4].map(ago), ["just now", "just now"]);
    assert.deepEqual([5, 59, 60, 3599, 3600, 86400].map(ago), ["5 s ago", "59 s ago", "1 min ago", "59 min ago", "1 h ago", "1 d ago"]);
    assert.equal(formatAgo(new Date(now.getTime() + 60_000), now), "just now", "a clock a little ahead is not an error");
  });
});

describe("workerLine", () => {
  it("is silent while nothing waits, or while what waits has not waited a minute", () => {
    assert.equal(workerLine({ count: 0, waitingSeconds: null }), null);
    assert.equal(workerLine({ count: 3, waitingSeconds: 59 }), null);
  });

  it("asks whether the worker is running, and says how to start it, once jobs have waited a minute", () => {
    assert.equal(workerLine({ count: 1, waitingSeconds: 60 }), "1 job has been due for 1 min and nobody has taken it. Is the worker running? Start it with: npm run modunexo -- worker");
    assert.equal(workerLine({ count: 4, waitingSeconds: 7300 }), "4 jobs have been due for 2 h and nobody has taken them. Is the worker running? Start it with: npm run modunexo -- worker");
  });
});

const job = (extra: Partial<JobRecord>): JobRecord => ({
  id: 1,
  moduleId: "inbox",
  name: "sync",
  status: "dead",
  runAt: new Date("2026-10-21T11:00:00Z"),
  attempts: 5,
  maxAttempts: 5,
  timeoutSeconds: 60,
  lastError: "boom",
  dedupeKey: "secret-key",
  enqueuedBy: "module",
  createdAt: new Date("2026-10-21T10:00:00Z"),
  startedAt: new Date("2026-10-21T11:30:00Z"),
  finishedAt: new Date("2026-10-21T11:31:00Z"),
  ...extra,
});

describe("troubleRows", () => {
  const now = new Date("2026-10-21T12:00:00Z");

  it("shapes a dead job and a job waiting for a retry, with only what a person needs", () => {
    const rows = troubleRows([job({}), job({ id: 2, status: "queued", attempts: 2, finishedAt: null, startedAt: new Date("2026-10-21T11:58:00Z"), lastError: "temporary trouble" })], now);
    assert.deepEqual(rows, [
      { id: 1, moduleId: "inbox", name: "sync", state: "dead", attempts: "5 of 5", when: "29 min ago", error: "boom" },
      { id: 2, moduleId: "inbox", name: "sync", state: "retrying", attempts: "2 of 5", when: "2 min ago", error: "temporary trouble" },
    ]);
  });

  it("cuts the error and carries no other field of the job", () => {
    const [row] = troubleRows([job({ lastError: `token ${"z".repeat(400)}` })], now);
    assert.equal(row!.error!.length, ERROR_CHARS);
    assert.deepEqual(Object.keys(row!).sort(), ["attempts", "error", "id", "moduleId", "name", "state", "when"], "no dedupe key, no enqueuer");
  });

  it("has no error to show when the job reported none, and falls back to when it started or was made", () => {
    const [row] = troubleRows([job({ lastError: null, finishedAt: null, startedAt: null })], now);
    assert.equal(row!.error, null);
    assert.equal(row!.when, "2 h ago");
  });
});

describe("modelRows", () => {
  const manifest = (id: string, name: string, llm?: { baseUrlSetting: string; apiKeySetting?: string; modelSetting?: string }) => ({ id, name, ...(llm === undefined ? {} : { llm }) });

  it("lists the enabled modules that call a model, by name, with the settings that configure it and no values", () => {
    const rows = modelRows(
      [
        manifest("zeta", "Zeta", { baseUrlSetting: "llm.url" }),
        manifest("agent", "Agent", { baseUrlSetting: "llm.url", apiKeySetting: "llm.key", modelSetting: "llm.model" }),
        manifest("plain", "Plain"),
        manifest("off", "Off", { baseUrlSetting: "llm.url" }),
      ],
      new Set(["zeta", "agent", "plain"]),
    );
    assert.deepEqual(rows, [
      { id: "agent", name: "Agent", endpointSetting: "llm.url", keySetting: "llm.key", modelSetting: "llm.model" },
      { id: "zeta", name: "Zeta", endpointSetting: "llm.url", keySetting: null, modelSetting: null },
    ]);
  });

  it("is empty when no enabled module calls a model", () => {
    assert.deepEqual(modelRows([manifest("plain", "Plain")], new Set(["plain"])), []);
    assert.deepEqual(modelRows([], new Set()), []);
  });
});

describe("probeSummary and probeError", () => {
  it("says where the test went, how long it took, and whether the module's model is there", () => {
    const base = { endpoint: "http://127.0.0.1:11434/v1", latencyMs: 12, models: ["m-a", "m-b"] };
    assert.deepEqual(probeSummary({ ...base, model: "m-b", modelAvailable: true }), ["Reached http://127.0.0.1:11434/v1 in 12 ms.", "The provider lists 2 models.", 'The model "m-b" is listed.']);
    assert.equal(probeSummary({ ...base, model: "gone", modelAvailable: false })[2], 'The model "gone" is not listed by the provider.');
    assert.equal(probeSummary({ ...base, model: null, modelAvailable: null })[2], "No model is set for this module.");
    assert.equal(probeSummary({ ...base, models: ["only"], model: null, modelAvailable: null })[1], "The provider lists 1 model.");
  });

  it("gives a refusal with its code, and tells nothing about an error it did not expect", () => {
    assert.deepEqual(probeError(new LlmError("unauthorized", "the provider answered HTTP 401")), { code: "unauthorized", message: "the provider answered HTTP 401" });
    const unexpected = probeError(new Error("connection string postgres://user:password@host/db"));
    assert.equal(unexpected.code, "unexpected");
    assert.ok(!unexpected.message.includes("password"), unexpected.message);
    assert.deepEqual(probeError("a string"), probeError(new TypeError("x")));
  });
});

describe("runProbe", () => {
  const manifests = [
    { id: "agent", llm: { baseUrlSetting: "llm.url" } },
    { id: "plain" },
    { id: "off", llm: { baseUrlSetting: "llm.url" } },
  ];
  const enabled = new Set(["agent", "plain"]);
  const result = { endpoint: "http://127.0.0.1:1/v1", latencyMs: 7, models: ["m"], model: "m", modelAvailable: true };
  const service = (probe: (id: string) => Promise<typeof result>) => ({ probe });

  it("tests the module's model and answers with the sentences to show", async () => {
    const asked: string[] = [];
    const reply = await runProbe({ service: service(async (id) => (asked.push(id), result)), manifests, enabled }, "agent");
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.body, { lines: probeSummary(result) });
    assert.deepEqual(asked, ["agent"]);
  });

  it("answers 404, and calls nothing, for a module that is unknown, calls no model or is not enabled", async () => {
    let calls = 0;
    const counting = service(async () => (calls += 1, result));
    for (const id of ["nobody", "plain", "off", "", "__proto__", "agent/../x"]) {
      const reply = await runProbe({ service: counting, manifests, enabled }, id);
      assert.equal(reply.status, 404, id);
      assert.deepEqual(reply.body, { error: "this module does not call a model", code: "not_found" }, id);
    }
    assert.equal(calls, 0);
  });

  it("answers 422 for a module that is not set up, and 502 for a provider that refuses, each with its code and message", async () => {
    const notSet = await runProbe({ service: service(async () => { throw new LlmError("not_configured", 'set the setting "llm.url" of module "agent" to the provider\'s base URL'); }), manifests, enabled }, "agent");
    assert.deepEqual([notSet.status, notSet.body], [422, { error: 'set the setting "llm.url" of module "agent" to the provider\'s base URL', code: "not_configured" }]);
    for (const code of ["unreachable", "timeout", "unauthorized", "rejected", "rate_limited", "bad_response", "too_large"] as const) {
      const reply = await runProbe({ service: service(async () => { throw new LlmError(code, `refused: ${code}`); }), manifests, enabled }, "agent");
      assert.deepEqual([reply.status, reply.body], [502, { error: `refused: ${code}`, code }], code);
    }
  });

  it("answers 500, saying nothing of what went wrong, for an error it did not expect, and hands it to the log", async () => {
    const logged: unknown[] = [];
    const failure = new Error("password=hunter2 in postgres://u:p@h/db");
    const reply = await runProbe({ service: service(async () => { throw failure; }), manifests, enabled, onUnexpected: (error) => void logged.push(error) }, "agent");
    assert.deepEqual([...logged], [failure], "the details go to the log, not to the browser");
    const refused = await runProbe({ service: service(async () => { throw new LlmError("timeout", "slow"); }), manifests, enabled, onUnexpected: (error) => void logged.push(error) }, "agent");
    assert.equal(refused.status, 502);
    assert.equal(logged.length, 1, "a refusal the platform raised is not logged as unexpected");
    assert.equal(reply.status, 500);
    assert.deepEqual(reply.body, { error: probeError(new Error("x")).message, code: "unexpected" });
    assert.ok(!JSON.stringify(reply.body).includes("hunter2"));
  });
});
