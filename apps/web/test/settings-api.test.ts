import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_BODY_BYTES, parseJsonBody, sameOriginRequest } from "../src/server/settings-api.ts";

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
