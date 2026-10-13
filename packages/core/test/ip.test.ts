import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cidrContains, effectiveClientAddress, formatIp, parseCidr, parseIp } from "../src/auth/ip.ts";

const cidrs = (...texts: string[]) =>
  texts.map((text) => {
    const parsed = parseCidr(text);
    assert.notEqual(parsed, null, text);
    return parsed!;
  });

describe("parseIp and formatIp", () => {
  it("reads IPv4 and IPv6, with brackets, a port and a zone, and writes one canonical form", () => {
    assert.equal(formatIp(parseIp("192.168.1.5")!), "192.168.1.5");
    assert.equal(formatIp(parseIp("192.168.1.5:51234")!), "192.168.1.5");
    assert.equal(formatIp(parseIp("[2001:DB8::1]:443")!), "2001:db8:0:0:0:0:0:1");
    assert.equal(formatIp(parseIp("2001:db8:0:0:0:0:0:1")!), "2001:db8:0:0:0:0:0:1");
    assert.equal(formatIp(parseIp("::1")!), "0:0:0:0:0:0:0:1");
    assert.equal(formatIp(parseIp("fe80::1%eth0")!), "fe80:0:0:0:0:0:0:1");
  });

  it("reads an IPv4-mapped IPv6 address as the IPv4 address it wraps", () => {
    assert.equal(formatIp(parseIp("::ffff:10.0.0.5")!), "10.0.0.5");
    assert.equal(formatIp(parseIp("::ffff:a00:5")!), "10.0.0.5");
  });

  it("refuses text that is not an address", () => {
    for (const text of ["", "unknown", "256.1.1.1", "1.2.3", "010.0.0.1", "::1::2", "10.0.0.1/8", "a b", "example.com"]) {
      assert.equal(parseIp(text), null, text);
    }
  });
});

describe("parseCidr", () => {
  it("accepts a range, and a bare address as a single-host range", () => {
    assert.notEqual(parseCidr("10.0.0.0/8"), null);
    assert.notEqual(parseCidr("192.168.1.5"), null);
    assert.notEqual(parseCidr("fd00::/8"), null);
    assert.notEqual(parseCidr("::1"), null);
    assert.notEqual(parseCidr("0.0.0.0/0"), null);
  });

  it("refuses a bad prefix, a bad address and anything else", () => {
    for (const text of ["10.0.0.0/33", "10.0.0.0/-1", "10.0.0.0/", "10.0.0.0/8/8", "fd00::/129", "10.0.0.0/08x", "nope", "", "/8", "10.0.0.0/ 8"]) {
      assert.equal(parseCidr(text), null, text);
    }
  });
});

describe("cidrContains", () => {
  it("matches the addresses inside a range and nothing next to it", () => {
    const [range] = cidrs("10.0.0.0/8");
    for (const inside of ["10.0.0.0", "10.255.255.255", "10.1.2.3"]) assert.equal(cidrContains(range!, parseIp(inside)!), true, inside);
    for (const outside of ["9.255.255.255", "11.0.0.0", "192.168.1.1"]) assert.equal(cidrContains(range!, parseIp(outside)!), false, outside);
  });

  it("treats a bare address as exactly that host", () => {
    const [host] = cidrs("192.168.1.5");
    assert.equal(cidrContains(host!, parseIp("192.168.1.5")!), true);
    assert.equal(cidrContains(host!, parseIp("192.168.1.6")!), false);
  });

  it("matches IPv6 ranges, and never an IPv4 address against an IPv6 range or the reverse", () => {
    const [v6, v4] = cidrs("fd00::/8", "10.0.0.0/8");
    assert.equal(cidrContains(v6!, parseIp("fd12:3456::1")!), true);
    assert.equal(cidrContains(v6!, parseIp("fe80::1")!), false);
    assert.equal(cidrContains(v6!, parseIp("10.0.0.5")!), false);
    assert.equal(cidrContains(v4!, parseIp("fd12::1")!), false);
  });

  it("matches a mapped address against an IPv4 range", () => {
    const [range] = cidrs("10.0.0.0/8");
    assert.equal(cidrContains(range!, parseIp("::ffff:10.0.0.9")!), true);
  });

  it("a zero-length prefix matches every address of its family", () => {
    const [all] = cidrs("0.0.0.0/0");
    assert.equal(cidrContains(all!, parseIp("203.0.113.9")!), true);
    assert.equal(cidrContains(all!, parseIp("2001:db8::1")!), false);
  });
});

describe("effectiveClientAddress", () => {
  const trusted = cidrs("10.0.0.0/24", "192.168.100.2");

  it("is the connection when the connection is not a trusted proxy, whatever the header says", () => {
    assert.equal(effectiveClientAddress("203.0.113.7", ["198.51.100.1"], trusted), "203.0.113.7");
    assert.equal(effectiveClientAddress("203.0.113.7", [], []), "203.0.113.7");
  });

  it("is the client a trusted proxy reports", () => {
    assert.equal(effectiveClientAddress("10.0.0.2", ["203.0.113.7"], trusted), "203.0.113.7");
  });

  it("reads from the right, so a client that forged the start of the header is not believed", () => {
    assert.equal(effectiveClientAddress("10.0.0.2", ["198.51.100.1", "203.0.113.7"], trusted), "203.0.113.7");
  });

  it("skips the proxies in a chain of trusted hops", () => {
    assert.equal(effectiveClientAddress("10.0.0.2", ["203.0.113.7", "192.168.100.2", "10.0.0.9"], trusted), "203.0.113.7");
  });

  it("falls back to the connection when there is nothing to read, or all of it is trusted", () => {
    assert.equal(effectiveClientAddress("10.0.0.2", [], trusted), "10.0.0.2");
    assert.equal(effectiveClientAddress("10.0.0.2", ["10.0.0.3", "192.168.100.2"], trusted), "10.0.0.2");
  });

  it("falls back to the connection on an entry it cannot read, so junk cannot mint new identities", () => {
    assert.equal(effectiveClientAddress("10.0.0.2", ["unknown"], trusted), "10.0.0.2");
    assert.equal(effectiveClientAddress("10.0.0.2", ["203.0.113.7", "garbage"], trusted), "10.0.0.2");
  });

  it("matches a trusted proxy that arrives in the mapped form, and writes IPv6 canonically", () => {
    assert.equal(effectiveClientAddress("::ffff:10.0.0.2", ["2001:DB8::7"], trusted), "2001:db8:0:0:0:0:0:7");
  });

  it("returns the connection as given when it cannot be read at all", () => {
    assert.equal(effectiveClientAddress("not-an-ip", ["203.0.113.7"], trusted), "not-an-ip");
  });
});
