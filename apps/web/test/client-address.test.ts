import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CLIENT_IP_HEADER, parseForwarded, requestAddresses, stampClientAddress } from "../src/server/client-address.ts";

const headersOf = (init: Record<string, string>) => new Headers(init);

describe("stampClientAddress", () => {
  it("sets the trusted header from the connection", () => {
    const headers: Record<string, string | string[] | undefined> = {};
    stampClientAddress(headers, "192.168.1.20");
    assert.equal(headers[CLIENT_IP_HEADER], "192.168.1.20");
  });

  it("replaces a value the client sent: it cannot be forged", () => {
    const headers: Record<string, string | string[] | undefined> = { [CLIENT_IP_HEADER]: "127.0.0.1", "x-forwarded-for": "10.0.0.1" };
    stampClientAddress(headers, "203.0.113.9");
    assert.equal(headers[CLIENT_IP_HEADER], "203.0.113.9");
    assert.equal(headers["x-forwarded-for"], "10.0.0.1", "other headers are left alone");
  });

  it("removes a repeated client-sent header entirely", () => {
    const headers: Record<string, string | string[] | undefined> = { [CLIENT_IP_HEADER]: ["127.0.0.1", "10.0.0.1"] };
    stampClientAddress(headers, "203.0.113.9");
    assert.equal(headers[CLIENT_IP_HEADER], "203.0.113.9");
  });

  it("leaves no header at all when the connection has no address, so the request is not treated as local", () => {
    const headers: Record<string, string | string[] | undefined> = { [CLIENT_IP_HEADER]: "127.0.0.1" };
    stampClientAddress(headers, undefined);
    assert.equal(CLIENT_IP_HEADER in headers, false);
  });
});

describe("parseForwarded", () => {
  it("reads the for= element of each hop, unquoted and without brackets or port", () => {
    assert.deepEqual(parseForwarded('for=192.0.2.60;proto=http;by=203.0.113.43'), ["192.0.2.60"]);
    assert.deepEqual(parseForwarded('For="[2001:db8:cafe::17]:4711", for=198.51.100.17'), ["2001:db8:cafe::17", "198.51.100.17"]);
    assert.deepEqual(parseForwarded("for=unknown, for=_hidden"), ["unknown", "_hidden"]);
  });

  it("returns nothing for a header without a for= element", () => {
    assert.deepEqual(parseForwarded("proto=https;by=10.0.0.1"), []);
    assert.deepEqual(parseForwarded(""), []);
  });
});

describe("requestAddresses", () => {
  it("is empty when the connection address was not stamped, whatever else the request says", () => {
    assert.deepEqual(requestAddresses(headersOf({})), []);
    assert.deepEqual(requestAddresses(headersOf({ "x-forwarded-for": "192.168.1.5" })), []);
  });

  it("starts with the connection address", () => {
    assert.deepEqual(requestAddresses(headersOf({ [CLIENT_IP_HEADER]: "192.168.1.5" })), ["192.168.1.5"]);
  });

  it("adds every address a proxy reports, from each of the usual headers", () => {
    const addresses = requestAddresses(
      headersOf({
        [CLIENT_IP_HEADER]: "127.0.0.1",
        "x-forwarded-for": "203.0.113.9, 10.0.0.1",
        forwarded: "for=198.51.100.7",
        "x-real-ip": "198.51.100.8",
        "cf-connecting-ip": "198.51.100.9",
        "true-client-ip": "198.51.100.10",
        "x-client-ip": "198.51.100.11",
      }),
    );
    assert.deepEqual(addresses, ["127.0.0.1", "203.0.113.9", "10.0.0.1", "198.51.100.7", "198.51.100.8", "198.51.100.9", "198.51.100.10", "198.51.100.11"]);
  });
});
