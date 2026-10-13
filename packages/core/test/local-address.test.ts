import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isLocalAddress, isLocalHostName, requestIsLocal, splitForwarded } from "../src/auth/local-address.ts";

describe("isLocalAddress", () => {
  it("accepts loopback, private and link-local IPv4", () => {
    for (const address of ["127.0.0.1", "127.8.9.10", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.20", "169.254.1.1"]) {
      assert.equal(isLocalAddress(address), true, address);
    }
  });

  it("accepts loopback, unique-local and link-local IPv6", () => {
    for (const address of ["::1", "0:0:0:0:0:0:0:1", "fe80::1", "febf::1", "fc00::1", "fd12:3456:789a::1", "fe80::1%eth0"]) {
      assert.equal(isLocalAddress(address), true, address);
    }
  });

  it("looks through the IPv4-mapped IPv6 form that dual-stack listeners report", () => {
    assert.equal(isLocalAddress("::ffff:127.0.0.1"), true);
    assert.equal(isLocalAddress("::ffff:192.168.1.5"), true);
    assert.equal(isLocalAddress("::ffff:c0a8:0105"), true);
    assert.equal(isLocalAddress("::ffff:8.8.8.8"), false);
    assert.equal(isLocalAddress("::ffff:808:808"), false);
  });

  it("ignores brackets, a port and surrounding whitespace", () => {
    for (const address of ["[::1]", "[::1]:3000", "192.168.1.5:51234", "  10.0.0.1  ", "[fe80::1]:443"]) {
      assert.equal(isLocalAddress(address), true, address);
    }
    assert.equal(isLocalAddress("8.8.8.8:443"), false);
    assert.equal(isLocalAddress("[2001:4860:4860::8888]:443"), false);
  });

  it("refuses public addresses, including the ranges next to the private ones", () => {
    for (const address of ["8.8.8.8", "1.1.1.1", "11.0.0.1", "172.15.255.255", "172.32.0.1", "192.169.0.1", "192.167.255.255", "169.253.0.1", "126.255.255.255", "128.0.0.1"]) {
      assert.equal(isLocalAddress(address), false, address);
    }
  });

  it("refuses shared address space, site-local and unspecified addresses", () => {
    for (const address of ["100.64.0.1", "100.127.255.255", "fec0::1", "0.0.0.0", "::", "2001:4860:4860::8888", "2606:4700::1111"]) {
      assert.equal(isLocalAddress(address), false, address);
    }
  });

  it("fails closed on anything that is not a well-formed address", () => {
    for (const address of ["", "   ", "unknown", "localhost", "not-an-ip", "256.1.1.1", "1.2.3", "10.0.0.1.5", "010.0.0.1", "::1::2", "fe80", "1:2:3:4:5:6:7:8:9", "10.0.0.1/8", "-1.0.0.1"]) {
      assert.equal(isLocalAddress(address), false, JSON.stringify(address));
    }
  });
});

describe("requestIsLocal", () => {
  it("is true only when every address the request carries is local", () => {
    assert.equal(requestIsLocal(["127.0.0.1"]), true);
    assert.equal(requestIsLocal(["192.168.1.5", "10.0.0.2"]), true);
    assert.equal(requestIsLocal(["127.0.0.1", "8.8.8.8"]), false);
    assert.equal(requestIsLocal(["8.8.8.8", "127.0.0.1"]), false);
  });

  it("is false when the request carries no address or one it cannot read", () => {
    assert.equal(requestIsLocal([]), false);
    assert.equal(requestIsLocal(["192.168.1.5", "unknown"]), false);
  });
});

describe("splitForwarded", () => {
  it("splits a comma separated header and trims each entry", () => {
    assert.deepEqual(splitForwarded("203.0.113.9, 10.0.0.1 ,192.168.1.1"), ["203.0.113.9", "10.0.0.1", "192.168.1.1"]);
  });

  it("returns nothing for a missing or empty header and keeps blank entries out", () => {
    assert.deepEqual(splitForwarded(null), []);
    assert.deepEqual(splitForwarded(undefined), []);
    assert.deepEqual(splitForwarded(""), []);
    assert.deepEqual(splitForwarded("10.0.0.1,, "), ["10.0.0.1"]);
  });
});

describe("isLocalHostName", () => {
  it("accepts local IP literals, with or without a port", () => {
    for (const host of ["127.0.0.1", "127.0.0.1:3000", "192.168.1.20:4000", "10.0.0.5", "[::1]:3000", "[fe80::1]", "[fd12:3456::1]:8080"]) {
      assert.equal(isLocalHostName(host), true, host);
    }
  });

  it("accepts localhost, single-label names and the private-use suffixes", () => {
    for (const host of ["localhost", "localhost:3000", "app.localhost", "raspberrypi", "raspberrypi:3000", "epnexo.local", "pi.lan:3000", "box.home.arpa", "svc.internal", "nas.localdomain", "EPNEXO.LOCAL"]) {
      assert.equal(isLocalHostName(host), true, host);
    }
  });

  it("refuses a public name: a DNS rebinding page or a public proxy sends one", () => {
    for (const host of ["evil.example", "evil.example:3000", "epnexo.dev", "epnexo.example.com", "a.b.c.com", "local.evil.example", "lan.com", "notlocalhost.com", "localhost.evil.example"]) {
      assert.equal(isLocalHostName(host), false, host);
    }
  });

  it("refuses a public IP literal, and anything that is not a host name", () => {
    for (const host of ["8.8.8.8", "8.8.8.8:3000", "[2001:db8::1]:443", "", "  ", "not a host", "evil.example/path", "user@evil.example", "10.0.0.1.5", "http://localhost"]) {
      assert.equal(isLocalHostName(host), false, JSON.stringify(host));
    }
  });
});
