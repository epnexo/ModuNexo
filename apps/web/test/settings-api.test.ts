import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_BODY_BYTES, parseJsonBody, readBodyBytes, readBodyText, sameOriginRequest } from "../src/server/settings-api.ts";

const headers = (init: Record<string, string>) => new Headers(init);

describe("sameOriginRequest", () => {
  it("is true when the Origin names the Host the request was sent to", () => {
    assert.equal(sameOriginRequest(headers({ origin: "http://192.168.1.20:3000", host: "192.168.1.20:3000" })), true);
    assert.equal(sameOriginRequest(headers({ origin: "https://epnexo.lan", host: "epnexo.lan" })), true);
  });

  it("is false for another site, another port, no Origin, or an Origin that is not a URL", () => {
    assert.equal(sameOriginRequest(headers({ origin: "https://evil.example", host: "192.168.1.20:3000" })), false);
    assert.equal(sameOriginRequest(headers({ origin: "http://192.168.1.20:3001", host: "192.168.1.20:3000" })), false);
    assert.equal(sameOriginRequest(headers({ host: "192.168.1.20:3000" })), false);
    assert.equal(sameOriginRequest(headers({ origin: "null", host: "192.168.1.20:3000" })), false);
    assert.equal(sameOriginRequest(headers({ origin: "garbage", host: "192.168.1.20:3000" })), false);
    assert.equal(sameOriginRequest(headers({ origin: "http://a" })), false);
  });

  it("does not let a forwarding header stand in for Host", () => {
    assert.equal(sameOriginRequest(headers({ origin: "https://evil.example", host: "192.168.1.20:3000", "x-forwarded-host": "evil.example" })), false);
  });
});

describe("parseJsonBody", () => {
  it("parses an object", () => {
    assert.deepEqual(parseJsonBody('{"a":1}'), { ok: true, body: { a: 1 } });
  });

  it("refuses text that is not JSON and a body over the limit, without echoing it", () => {
    const bad = parseJsonBody("{ nope");
    assert.equal(bad.ok, false);
    const big = parseJsonBody(JSON.stringify({ v: "x".repeat(MAX_BODY_BYTES) }));
    assert.equal(big.ok, false);
    if (!big.ok) assert.ok(!big.message.includes("xxxx"));
  });
});

describe("readBodyText", () => {
  const request = (body: BodyInit | null, headers: Record<string, string> = {}) => new Request("http://localhost/x", { method: "PUT", body, headers, duplex: "half" } as RequestInit);

  it("reads a body within the limit", async () => {
    assert.deepEqual(await readBodyText(request('{"a":1}')), { ok: true, text: '{"a":1}' });
    assert.deepEqual(await readBodyText(request(null)), { ok: true, text: "" });
  });

  it("refuses a body over the limit and stops reading it", async () => {
    let chunksRead = 0;
    const chunk = new Uint8Array(16 * 1024).fill(120);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksRead += 1;
        if (chunksRead > 200) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const result = await readBodyText(request(stream));
    assert.equal(result.ok, false);
    assert.ok(chunksRead < 20, `read ${chunksRead} chunks of a body that should have been cut at ${MAX_BODY_BYTES} bytes`);
  });

  it("refuses at once when content-length already says it is too large", async () => {
    let pulled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled = true;
        controller.close();
      },
    });
    const result = await readBodyText(request(stream, { "content-length": String(MAX_BODY_BYTES + 1) }));
    assert.equal(result.ok, false);
    assert.equal(pulled, false);
  });
});

describe("readBodyBytes", () => {
  const request = (body: BodyInit | null, headers: Record<string, string> = {}) => new Request("http://localhost/x", { method: "PUT", body, headers, duplex: "half" } as RequestInit);

  it("reads binary content within its own limit, byte for byte", async () => {
    const bytes = Uint8Array.from([0, 255, 128, 10]);
    const result = await readBodyBytes(request(bytes), 10);
    assert.deepEqual(result.ok && [...result.bytes], [0, 255, 128, 10]);
  });

  it("refuses a body over the limit, declared or streamed", async () => {
    assert.equal((await readBodyBytes(request(new Uint8Array(11)), 10)).ok, false);
    assert.equal((await readBodyBytes(request(new Uint8Array(1), { "content-length": "999" }), 10)).ok, false);
  });
});
