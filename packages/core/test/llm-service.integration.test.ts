import assert from "node:assert/strict";
import { type IncomingHttpHeaders, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import { type ChatRequest, LlmError } from "@modunexo/sdk";
import { LlmService } from "../src/llm/index.ts";
import { migrate } from "../src/runner.ts";
import { createPool } from "../src/pool.ts";
import { SettingsService } from "../src/settings/service.ts";
import { createScratchDatabase } from "../src/testing.ts";
import { Sandbox } from "./sandbox.ts";

const KEY = "m".repeat(40);
const OTHER_KEY = "n".repeat(40);
const API_KEY = "sk-from-the-store-0123456789";

let pool: pg.Pool | undefined;
let skipReason: string | undefined;
let dropScratch: (() => Promise<void>) | undefined;
let box: Sandbox;
let agentId: string;
let plainId: string;
let offId: string;
let nokeyId: string;
let settings: SettingsService;
let service: LlmService;

interface Seen {
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: string;
}
let seen: Seen[] = [];
let respond: (response: ServerResponse) => void = () => undefined;
let closeServer: () => Promise<void>;
let serverUrl = "";

const llmSettings = [
  { key: "llm.url", label: "Endpoint", type: "string" },
  { key: "llm.key", label: "API key", type: "secret" },
  { key: "llm.model", label: "Model", type: "string" },
] as const;

before(async () => {
  const scratch = await createScratchDatabase();
  if (!scratch.url) {
    skipReason = scratch.skipReason;
    return;
  }
  dropScratch = scratch.drop;
  pool = createPool(scratch.url);
  box = new Sandbox(pool);
  const agent = box.add();
  agentId = agent.manifest.id;
  agent.manifest.settings = [...llmSettings];
  agent.manifest.llm = { baseUrlSetting: "llm.url", apiKeySetting: "llm.key", modelSetting: "llm.model" };
  const plain = box.add();
  plainId = plain.manifest.id;
  const off = box.add();
  offId = off.manifest.id;
  off.manifest.settings = [...llmSettings];
  off.manifest.llm = { baseUrlSetting: "llm.url" };
  const nokey = box.add();
  nokeyId = nokey.manifest.id;
  nokey.manifest.settings = [llmSettings[0]];
  nokey.manifest.llm = { baseUrlSetting: "llm.url" };
  await migrate(pool, box.registry());
  settings = new SettingsService(pool, box.registry(), { masterKey: KEY });
  service = new LlmService(pool, box.registry(), { settings: (moduleId, key) => settings.get(moduleId, key) });

  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      seen.push({ url: request.url, headers: request.headers, body });
      respond(response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closeServer = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
});

const answer = (status: number, body: unknown) => (response: ServerResponse) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};
const completion = { model: "m1-2026", choices: [{ message: { role: "assistant", content: "the answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } };

const wipe = async () => {
  await pool!.query("delete from core.module_settings");
  await pool!.query("delete from core.modules where id = any($1)", [[agentId, plainId, offId, nokeyId]]);
  for (const [id, state] of [[agentId, "enabled"], [plainId, "enabled"], [offId, "disabled"], [nokeyId, "enabled"]]) {
    await pool!.query("insert into core.modules (id, state, installed_version) values ($1, $2, '1.0.0')", [id, state]);
  }
  seen = [];
  respond = answer(200, completion);
};
const configure = async (moduleId = agentId, values: Record<string, string> = {}) => {
  const all = { "llm.url": `${serverUrl}/v1`, "llm.key": API_KEY, "llm.model": "m1", ...values };
  for (const [key, value] of Object.entries(all)) if (value !== "") await settings.set(moduleId, key, value, "test");
};
const ask = (extra: Partial<ChatRequest> = {}): ChatRequest => ({ messages: [{ role: "user", content: "hello" }], ...extra });
const refused = async (work: Promise<unknown>): Promise<LlmError> => {
  try {
    await work;
  } catch (error) {
    assert.ok(error instanceof LlmError, `expected an LlmError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected the call to be refused");
};

after(async () => {
  if (pool) {
    await pool.query("delete from core.module_settings").catch(() => undefined);
    await box.cleanup().catch(() => undefined);
    await pool.end();
    await closeServer();
  }
  await dropScratch?.();
});

describe("LlmService.chat", { concurrency: false }, () => {
  it("calls the provider the module's settings name, with the key from the secret store and the model setting", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    await configure();
    const result = await service.chat(agentId, ask({ temperature: 0.1, maxTokens: 20 }));
    assert.deepEqual(result, { content: "the answer", model: "m1-2026", finishReason: "stop", usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 } });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.url, "/v1/chat/completions");
    assert.equal(seen[0]!.headers.authorization, `Bearer ${API_KEY}`);
    assert.deepEqual(JSON.parse(seen[0]!.body), { model: "m1", messages: [{ role: "user", content: "hello" }], stream: false, temperature: 0.1, max_tokens: 20 });
  });

  it("lets a call name its own model, and sends no key to a module that has none", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    await configure(agentId, { "llm.key": "" });
    await service.chat(agentId, ask({ model: "other-model" }));
    assert.equal(JSON.parse(seen[0]!.body).model, "other-model");
    assert.equal(seen[0]!.headers.authorization, undefined);
    await wipe();
    await configure(nokeyId, { "llm.key": "", "llm.model": "" });
    await service.chat(nokeyId, ask({ model: "local" }));
    assert.equal(seen[0]!.headers.authorization, undefined);
  });

  it("reads the settings at every call, so a change takes effect at once", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    await configure();
    await service.chat(agentId, ask());
    await settings.set(agentId, "llm.model", "changed", "test");
    await service.chat(agentId, ask());
    assert.deepEqual(seen.map((s) => JSON.parse(s.body).model), ["m1", "changed"]);
  });

  it("reads the master key from the environment when it is given no settings reader", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    await configure();
    const previous = process.env.MODUNEXO_MASTER_KEY;
    process.env.MODUNEXO_MASTER_KEY = KEY;
    try {
      await new LlmService(pool!, box.registry()).chat(agentId, ask());
    } finally {
      if (previous === undefined) delete process.env.MODUNEXO_MASTER_KEY;
      else process.env.MODUNEXO_MASTER_KEY = previous;
    }
    assert.equal(seen[0]!.headers.authorization, `Bearer ${API_KEY}`);
  });

  it("says what is missing, and calls nothing, for a module that is not set up to call a model", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    const codes = async (moduleId: string) => (await refused(service.chat(moduleId, ask()))).code;
    assert.equal(await codes("nobody"), "not_configured");
    const plain = await refused(service.chat(plainId, ask()));
    assert.deepEqual([plain.code, /does not declare llm/.test(plain.message)], ["not_configured", true]);
    const off = await refused(service.chat(offId, ask()));
    assert.deepEqual([off.code, /not enabled/.test(off.message)], ["not_configured", true]);
    const noUrl = await refused(service.chat(agentId, ask()));
    assert.equal(noUrl.code, "not_configured");
    assert.ok(noUrl.message.includes('"llm.url"'), noUrl.message);
    await configure(agentId, { "llm.url": "ftp://example.com" });
    const badUrl = await refused(service.chat(agentId, ask()));
    assert.equal(badUrl.code, "not_configured");
    assert.ok(badUrl.message.includes('"llm.url"') && /http or https/.test(badUrl.message), badUrl.message);
    await wipe();
    await configure(agentId, { "llm.model": "" });
    const noModel = await refused(service.chat(agentId, ask()));
    assert.equal(noModel.code, "not_configured");
    assert.ok(noModel.message.includes('"llm.model"'), noModel.message);
    assert.equal(seen.length, 0, "nothing was sent");
  });

  it("refuses a request that is wrong before it reaches the network", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    await configure();
    const long = "x".repeat(100_001);
    const bad: unknown[] = [
      undefined,
      null,
      "hello",
      {},
      { messages: "hi" },
      { messages: [] },
      { messages: Array.from({ length: 201 }, () => ({ role: "user", content: "x" })) },
      { messages: [null] },
      { messages: [{ role: "tool", content: "x" }] },
      { messages: [{ role: "user", content: "" }] },
      { messages: [{ role: "user", content: 5 }] },
      { messages: [{ role: "user" }] },
      { messages: [{ role: "user", content: long }, { role: "user", content: long }] },
      { ...ask(), temperature: -0.1 },
      { ...ask(), temperature: 2.1 },
      { ...ask(), temperature: Number.NaN },
      { ...ask(), temperature: "0.5" },
      { ...ask(), maxTokens: 0 },
      { ...ask(), maxTokens: 1.5 },
      { ...ask(), maxTokens: 32769 },
      { ...ask(), maxTokens: "10" },
      { ...ask(), model: "" },
      { ...ask(), model: 5 },
      { ...ask(), model: "bad\nmodel" },
      { ...ask(), model: "m".repeat(201) },
    ];
    for (const request of bad) {
      const error = await refused(service.chat(agentId, request as ChatRequest));
      assert.equal(error.code, "invalid_request", JSON.stringify(request)?.slice(0, 80));
    }
    assert.equal(seen.length, 0, "no call was made");
    await service.chat(agentId, { messages: [{ role: "system", content: "s" }, { role: "assistant", content: "a" }, { role: "user", content: "u" }], temperature: 0, maxTokens: 32768 });
    await service.chat(agentId, { messages: [{ role: "user", content: long }, { role: "user", content: "y".repeat(99_999) }] });
    assert.equal(seen.length, 2, "the limits themselves are allowed");
  });

  it("refuses a list of messages with holes, and sends what it checked and nothing more", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    await configure();
    // eslint-disable-next-line no-sparse-arrays
    const sparse: unknown[] = [{ messages: new Array(1) }, { messages: [{ role: "user", content: "a" }, , { role: "user", content: "b" }] }, { messages: Object.assign([{ role: "user", content: "a" }], { length: 3 }) }];
    for (const request of sparse) {
      assert.equal((await refused(service.chat(agentId, request as ChatRequest))).code, "invalid_request", JSON.stringify(request));
    }
    assert.equal(seen.length, 0, "no call was made");

    let reads = 0;
    const shifting = { role: "user", get content() { return reads++ === 0 ? "as checked" : ""; }, name: "extra", tool_calls: [{ id: "x" }] };
    await service.chat(agentId, { messages: [shifting as never] });
    assert.deepEqual(JSON.parse(seen[0]!.body).messages, [{ role: "user", content: "as checked" }]);
  });

  it("asks to set a key again when the stored one cannot be read, without saying what it was", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    await configure();
    const rotated = new SettingsService(pool!, box.registry(), { masterKey: OTHER_KEY });
    const broken = new LlmService(pool!, box.registry(), { settings: (moduleId, key) => rotated.get(moduleId, key) });
    const error = await refused(broken.chat(agentId, ask()));
    assert.equal(error.code, "not_configured");
    assert.ok(error.message.includes('"llm.key"') && /again/.test(error.message), error.message);
    assert.ok(!error.message.includes(API_KEY));
    assert.equal(seen.length, 0);
  });

  it("passes the provider's refusal on with its code, and never the key", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    await configure();
    respond = answer(401, { error: { message: `bad key ${API_KEY}` } });
    const error = await refused(service.chat(agentId, ask()));
    assert.equal(error.code, "unauthorized");
    assert.ok(!error.message.includes(API_KEY), error.message);
  });

  it("stops when the caller's signal aborts", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    await configure();
    respond = () => undefined;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(() => service.chat(agentId, ask({ signal: controller.signal })), (error) => error instanceof Error && !(error instanceof LlmError) && error.name === "AbortError");
  });
});

describe("LlmService.probe", { concurrency: false }, () => {
  it("lists the provider's models, times the call and says whether the configured one is there", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    await configure(agentId, { "llm.model": "m-b" });
    respond = answer(200, { data: [{ id: "m-a" }, { id: "m-b" }] });
    const result = await service.probe(agentId);
    assert.deepEqual([result.models, result.model, result.modelAvailable], [["m-a", "m-b"], "m-b", true]);
    assert.ok(Number.isFinite(result.latencyMs) && result.latencyMs >= 0);
    assert.equal(seen[0]!.url, "/v1/models");
    assert.equal(seen[0]!.headers.authorization, `Bearer ${API_KEY}`);

    await settings.set(agentId, "llm.model", "missing", "test");
    assert.deepEqual([(await service.probe(agentId)).model, (await service.probe(agentId)).modelAvailable], ["missing", false]);
  });

  it("has no answer about the model when none is configured, and shows at most 50 ids", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    await configure(agentId, { "llm.model": "" });
    respond = answer(200, { data: Array.from({ length: 80 }, (_, i) => ({ id: `m-${i}` })) });
    const result = await service.probe(agentId);
    assert.deepEqual([result.model, result.modelAvailable, result.models.length], [null, null, 50]);
    await settings.set(agentId, "llm.model", "m-75", "test");
    const late = await service.probe(agentId);
    assert.deepEqual([late.modelAvailable, late.models.length], [true, 50], "availability looks at the whole list");
  });

  it("refuses the same way chat does, and reports a provider that fails", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    assert.equal((await refused(service.probe(plainId))).code, "not_configured");
    assert.equal((await refused(service.probe(agentId))).code, "not_configured");
    await configure();
    respond = answer(500, { error: { message: "down" } });
    assert.equal((await refused(service.probe(agentId))).code, "rejected");
  });
});
