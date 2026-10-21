import assert from "node:assert/strict";
import { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import { LlmError } from "@modunexo/sdk";
import { OpenAiCompatibleProvider, parseBaseUrl } from "../src/llm/index.ts";

interface Seen {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: string;
}

const servers: Array<() => Promise<void>> = [];
after(async () => {
  for (const close of servers) await close();
});

async function serve(handler: (request: Seen, response: ServerResponse, raw: IncomingMessage) => void): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const entry = { method: request.method, url: request.url, headers: request.headers, body };
      seen.push(entry);
      handler(entry, response, request);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const json = (response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
};

const completion = (extra: Record<string, unknown> = {}) => ({
  id: "c1",
  model: "gpt-test-2026",
  choices: [{ index: 0, message: { role: "assistant", content: "hello there" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
  ...extra,
});

const input = { model: "gpt-test", messages: [{ role: "user" as const, content: "hi" }] };

const failure = async (work: Promise<unknown>): Promise<LlmError> => {
  try {
    await work;
  } catch (error) {
    assert.ok(error instanceof LlmError, `expected an LlmError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected the call to be refused");
};

describe("parseBaseUrl", () => {
  it("takes an http or https URL and drops a trailing slash", () => {
    assert.equal(parseBaseUrl("https://api.example.com/v1/"), "https://api.example.com/v1");
    assert.equal(parseBaseUrl("  http://127.0.0.1:11434/v1  "), "http://127.0.0.1:11434/v1");
    assert.equal(parseBaseUrl("http://localhost:8080"), "http://localhost:8080");
    assert.equal(parseBaseUrl("https://[::1]:9000/v1"), "https://[::1]:9000/v1");
  });

  it("refuses anything else: another scheme, credentials, a query, a fragment, no host, not a URL", () => {
    for (const bad of ["", "   ", "api.example.com/v1", "ftp://example.com", "file:///etc/passwd", "javascript:alert(1)", "https://user:pass@example.com/v1", "https://user@example.com", "https://example.com/v1?key=abc", "https://example.com/v1#frag", "http://", "https://", "not a url"]) {
      assert.throws(() => parseBaseUrl(bad), (error) => error instanceof Error && /URL/.test(error.message), JSON.stringify(bad));
    }
  });
});

describe("OpenAiCompatibleProvider.chat", () => {
  it("posts the conversation to /chat/completions with the key and reads the first choice", async () => {
    const server = await serve((_, response) => json(response, 200, completion()));
    const provider = new OpenAiCompatibleProvider({ baseUrl: `${server.url}/v1/`, apiKey: "sk-secret-123" });
    const result = await provider.chat({ ...input, temperature: 0.4, maxTokens: 50 });
    assert.deepEqual(result, { content: "hello there", model: "gpt-test-2026", finishReason: "stop", usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 } });
    const request = server.seen[0]!;
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.headers.authorization, "Bearer sk-secret-123");
    assert.match(String(request.headers["content-type"]), /^application\/json/);
    assert.deepEqual(JSON.parse(request.body), { model: "gpt-test", messages: input.messages, stream: false, temperature: 0.4, max_tokens: 50 });
  });

  it("leaves out the key, the temperature and the token limit when there are none", async () => {
    const server = await serve((_, response) => json(response, 200, completion({ usage: undefined, model: undefined })));
    const result = await new OpenAiCompatibleProvider({ baseUrl: server.url, apiKey: null }).chat(input);
    assert.equal(server.seen[0]!.headers.authorization, undefined);
    assert.equal(server.seen[0]!.url, "/chat/completions");
    assert.deepEqual(JSON.parse(server.seen[0]!.body), { model: "gpt-test", messages: input.messages, stream: false });
    assert.deepEqual([result.usage, result.model], [null, "gpt-test"], "no usage reported; the requested model stands in");
  });

  it("maps the provider's refusals to a code, and says what the provider said", async () => {
    const cases: Array<[number, string, string]> = [
      [401, "unauthorized", "Incorrect API key provided"],
      [403, "unauthorized", "Forbidden"],
      [429, "rate_limited", "Rate limit reached"],
      [408, "timeout", "Request timeout"],
      [400, "rejected", "Unknown parameter"],
      [404, "rejected", "model not found"],
      [500, "rejected", "internal error"],
      [503, "rejected", "overloaded"],
    ];
    for (const [status, code, message] of cases) {
      const server = await serve((_, response) => json(response, status, { error: { message } }));
      const error = await failure(new OpenAiCompatibleProvider({ baseUrl: server.url, apiKey: "sk-x" }).chat(input));
      assert.equal(error.code, code, String(status));
      assert.ok(error.message.includes(message), `${status}: ${error.message}`);
      assert.ok(error.message.includes(String(status)), `${status}: ${error.message}`);
    }
  });

  it("never lets the key into an error: it is removed from what the provider said, and what it said is cut", async () => {
    const key = "sk-live-0123456789abcdef";
    const server = await serve((_, response) => json(response, 401, { error: { message: `Incorrect API key provided: ${key}. ${"x".repeat(500)}` } }));
    const error = await failure(new OpenAiCompatibleProvider({ baseUrl: server.url, apiKey: key }).chat(input));
    assert.ok(!error.message.includes(key), error.message);
    assert.match(error.message, /\[redacted\]/);
    assert.ok(error.message.length < 400, `${error.message.length} characters`);
    const plain = await serve((_, response) => {
      response.writeHead(502, { "content-type": "text/html" });
      response.end(`<html>bad gateway ${key}</html>`);
    });
    const other = await failure(new OpenAiCompatibleProvider({ baseUrl: plain.url, apiKey: key }).chat(input));
    assert.ok(!other.message.includes(key), other.message);
    assert.equal(other.code, "rejected");
  });

  it("does not follow a redirect, so the key cannot be sent to another host", async () => {
    const elsewhere = await serve((_, response) => json(response, 200, completion()));
    const server = await serve((_, response) => {
      response.writeHead(307, { location: `${elsewhere.url}/chat/completions` });
      response.end();
    });
    const error = await failure(new OpenAiCompatibleProvider({ baseUrl: server.url, apiKey: "sk-secret" }).chat(input));
    assert.equal(error.code, "rejected");
    assert.match(error.message, /redirect/i);
    assert.equal(elsewhere.seen.length, 0, "the other host never saw a request");
  });

  it("refuses a reply that is not a completion", async () => {
    const replies: unknown[] = [
      "not json at all",
      {},
      { choices: [] },
      { choices: [{}] },
      { choices: [{ message: { content: null }, finish_reason: "tool_calls" }] },
      { choices: [{ message: { content: 5 } }] },
      [],
      null,
    ];
    for (const reply of replies) {
      const server = await serve((_, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(typeof reply === "string" ? reply : JSON.stringify(reply));
      });
      const error = await failure(new OpenAiCompatibleProvider({ baseUrl: server.url, apiKey: null }).chat(input));
      assert.equal(error.code, "bad_response", JSON.stringify(reply));
    }
  });

  it("reads a reply up to its cap and no further", async () => {
    const big = await serve((_, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"choices":[{"message":{"content":"');
      response.write("a".repeat(5000));
      response.end('"}}]}');
    });
    const error = await failure(new OpenAiCompatibleProvider({ baseUrl: big.url, apiKey: null, maxResponseBytes: 1000 }).chat(input));
    assert.equal(error.code, "too_large");
    const declared = await serve((_, response) => {
      response.writeHead(200, { "content-type": "application/json", "content-length": "99999999" });
      response.end("{}");
    });
    const early = await failure(new OpenAiCompatibleProvider({ baseUrl: declared.url, apiKey: null, maxResponseBytes: 1000 }).chat(input));
    assert.equal(early.code, "too_large");
    const fits = await serve((_, response) => json(response, 200, completion()));
    assert.equal((await new OpenAiCompatibleProvider({ baseUrl: fits.url, apiKey: null, maxResponseBytes: 1000 }).chat(input)).content, "hello there");
  });

  it("gives up after its time limit", async () => {
    const silent = await serve(() => undefined);
    const started = Date.now();
    const error = await failure(new OpenAiCompatibleProvider({ baseUrl: silent.url, apiKey: null, timeoutMs: 150 }).chat(input));
    assert.equal(error.code, "timeout");
    assert.match(error.message, /did not answer/);
    assert.ok(Date.now() - started < 3000);
  });

  it("stops when the caller aborts, with the abort and not with a model error", async () => {
    const silent = await serve(() => undefined);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(
      () => new OpenAiCompatibleProvider({ baseUrl: silent.url, apiKey: null }).chat(input, controller.signal),
      (error) => error instanceof Error && !(error instanceof LlmError) && error.name === "AbortError",
    );
    const already = AbortSignal.abort();
    await assert.rejects(() => new OpenAiCompatibleProvider({ baseUrl: silent.url, apiKey: null }).chat(input, already), (error) => error instanceof Error && error.name === "AbortError");
  });

  it("says a server could not be reached, naming the host and not the key", async () => {
    const closed = await serve(() => undefined);
    const url = closed.url;
    await servers.at(-1)!();
    const error = await failure(new OpenAiCompatibleProvider({ baseUrl: `${url}/v1`, apiKey: "sk-secret-key" }).chat(input));
    assert.equal(error.code, "unreachable");
    assert.ok(error.message.includes(url), error.message);
    assert.ok(!error.message.includes("sk-secret-key"));
  });
});

describe("OpenAiCompatibleProvider.models", () => {
  it("lists the ids the provider reports, asking with the key", async () => {
    const server = await serve((_, response) => json(response, 200, { object: "list", data: [{ id: "gpt-a" }, { id: "gpt-b", owned_by: "x" }, { nope: 1 }, "junk", { id: 5 }] }));
    const models = await new OpenAiCompatibleProvider({ baseUrl: `${server.url}/v1`, apiKey: "sk-secret" }).models();
    assert.deepEqual(models, ["gpt-a", "gpt-b"]);
    assert.equal(server.seen[0]!.method, "GET");
    assert.equal(server.seen[0]!.url, "/v1/models");
    assert.equal(server.seen[0]!.headers.authorization, "Bearer sk-secret");
  });

  it("refuses a reply that is not a list, and maps a refusal like chat does", async () => {
    for (const reply of [{}, { data: "x" }, [], "nope"]) {
      const server = await serve((_, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(reply));
      });
      assert.equal((await failure(new OpenAiCompatibleProvider({ baseUrl: server.url, apiKey: null }).models())).code, "bad_response", JSON.stringify(reply));
    }
    const refused = await serve((_, response) => json(response, 401, { error: { message: "bad key" } }));
    assert.equal((await failure(new OpenAiCompatibleProvider({ baseUrl: refused.url, apiKey: "k" }).models())).code, "unauthorized");
  });
});
