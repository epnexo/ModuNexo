import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { LLM_CLIENT, LlmError, type LlmClient, LlmUnavailableError, ManifestError, chat, probeLlm, validateManifest } from "../src/index.ts";

const base = {
  id: "agent",
  version: "1.0.0",
  name: "Agent",
  platform: "^0.1.0",
  dependsOn: {},
  schema: "agent",
  migrationsDir: "migrations",
  nav: [],
};

const settings = [
  { key: "llm.url", label: "Endpoint", type: "string" },
  { key: "llm.key", label: "API key", type: "secret" },
  { key: "llm.model", label: "Model", type: "string" },
  { key: "llm.pick", label: "Model", type: "select", options: ["a", "b"] },
  { key: "llm.count", label: "Count", type: "number" },
  { key: "llm.dir", label: "Dir", type: "path" },
];

const problemsOf = (input: unknown): string[] => {
  try {
    validateManifest(input);
  } catch (error) {
    assert.ok(error instanceof ManifestError);
    return error.problems;
  }
  return [];
};

describe("validateManifest: llm", () => {
  const withLlm = (llm: unknown, extra: Record<string, unknown> = {}) => ({ ...base, settings, ...extra, llm });

  it("accepts no llm, the base URL alone and a full declaration", () => {
    assert.deepEqual(problemsOf({ ...base, settings }), []);
    assert.deepEqual(problemsOf(withLlm({ baseUrlSetting: "llm.url" })), []);
    assert.deepEqual(problemsOf(withLlm({ baseUrlSetting: "llm.url", apiKeySetting: "llm.key", modelSetting: "llm.model" })), []);
    assert.deepEqual(problemsOf(withLlm({ baseUrlSetting: "llm.url", apiKeySetting: "llm.key", modelSetting: "llm.pick" })), []);
  });

  it("requires an object", () => {
    for (const llm of ["yes", true, [], null, 1]) {
      assert.ok(problemsOf(withLlm(llm)).some((p) => p.startsWith("llm")), JSON.stringify(llm));
    }
  });

  it("requires the base URL setting, and that it is a declared string", () => {
    for (const baseUrlSetting of [undefined, "", 5, "llm.nope", "llm.key", "llm.count", "llm.pick", "llm.dir"]) {
      assert.ok(problemsOf(withLlm({ baseUrlSetting })).some((p) => p.includes("llm.baseUrlSetting")), String(baseUrlSetting));
    }
    assert.ok(problemsOf({ ...base, llm: { baseUrlSetting: "llm.url" } }).some((p) => p.includes("llm.baseUrlSetting")), "no settings at all");
  });

  it("requires the key to be a declared secret and the model a declared string or select", () => {
    for (const apiKeySetting of ["llm.url", "llm.nope", 5, ""]) {
      assert.ok(problemsOf(withLlm({ baseUrlSetting: "llm.url", apiKeySetting })).some((p) => p.includes("llm.apiKeySetting")), String(apiKeySetting));
    }
    for (const modelSetting of ["llm.key", "llm.count", "llm.nope", 5, ""]) {
      assert.ok(problemsOf(withLlm({ baseUrlSetting: "llm.url", modelSetting })).some((p) => p.includes("llm.modelSetting")), String(modelSetting));
    }
  });

  it("refuses unknown fields", () => {
    assert.ok(problemsOf(withLlm({ baseUrlSetting: "llm.url", provider: "x" })).some((p) => p.includes('unknown field "provider"')));
  });
});

describe("llm functions", () => {
  const slot = globalThis as typeof globalThis & { [LLM_CLIENT]?: LlmClient };
  afterEach(() => {
    delete slot[LLM_CLIENT];
  });

  const result = { content: "hi", model: "m", finishReason: "stop", usage: null };
  const probe = { endpoint: "http://127.0.0.1:1/v1", latencyMs: 3, models: ["m"], model: "m", modelAvailable: true };

  it("fail clearly where the platform registered no client", async () => {
    await assert.rejects(() => chat("agent", { messages: [{ role: "user", content: "x" }] }), LlmUnavailableError);
    await assert.rejects(() => probeLlm("agent"), LlmUnavailableError);
  });

  it("hand the module and the request to the registered client", async () => {
    const calls: unknown[][] = [];
    slot[LLM_CLIENT] = {
      chat: async (...args) => {
        calls.push(["chat", ...args]);
        return result;
      },
      probe: async (...args) => {
        calls.push(["probe", ...args]);
        return probe;
      },
    };
    const request = { messages: [{ role: "user" as const, content: "x" }], temperature: 0.2 };
    assert.deepEqual(await chat("agent", request), result);
    assert.deepEqual(await probeLlm("agent"), probe);
    assert.deepEqual(calls, [["chat", "agent", request], ["probe", "agent"]]);
  });

  it("is recognised by instanceof even when it was raised by another copy of the SDK", () => {
    // A bundler may load the SDK twice: the platform raises the error from one copy and the module catches it with the other.
    const fromAnotherCopy = Object.assign(new Error("the provider answered HTTP 401"), { name: "LlmError", code: "unauthorized", [Symbol.for("modunexo.llm.error")]: true });
    assert.ok(fromAnotherCopy instanceof LlmError);
    assert.ok(new LlmError("timeout", "slow") instanceof LlmError);
    for (const other of [new Error("x"), Object.assign(new Error("x"), { name: "LlmError", code: "timeout" }), null, undefined, "LlmError", { code: "timeout" }, 5]) {
      assert.equal(other instanceof LlmError, false, String(other));
    }
  });

  it("carries a code on the error the platform raises", () => {
    const error = new LlmError("timeout", "the model did not answer within 60 s");
    assert.ok(error instanceof Error);
    assert.deepEqual([error.name, error.code, error.message], ["LlmError", "timeout", "the model did not answer within 60 s"]);
  });
});
