import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeApiAddress, resolveApiAddress, serviceEndpoints } from "../src/api-access/index.ts";

describe("normalizeApiAddress", () => {
  it("keeps only the origin of a web address", () => {
    assert.equal(normalizeApiAddress(" https://modunexo.home.arpa/ "), "https://modunexo.home.arpa");
    assert.equal(normalizeApiAddress("https://modunexo.home.arpa/settings#modules"), "https://modunexo.home.arpa");
    assert.equal(normalizeApiAddress("http://127.0.0.1:3000/x?y=1"), "http://127.0.0.1:3000");
  });

  it("refuses what is not a plain web address", () => {
    for (const bad of ["", "   ", "modunexo.home.arpa", "ftp://modunexo.home.arpa", "javascript:alert(1)", "https://user:secret@modunexo.home.arpa", "https://"]) {
      assert.throws(() => normalizeApiAddress(bad), /address/i, bad);
    }
  });
});

describe("resolveApiAddress", () => {
  it("prefers the saved address, then WEB_PUBLIC_URL, then the request", () => {
    assert.deepEqual(resolveApiAddress({ saved: "https://a.test", publicUrl: "https://b.test", requestOrigin: "https://c.test" }), { address: "https://a.test", source: "saved" });
    assert.deepEqual(resolveApiAddress({ saved: null, publicUrl: "https://b.test", requestOrigin: "https://c.test" }), { address: "https://b.test", source: "public-url" });
    assert.deepEqual(resolveApiAddress({ saved: null, publicUrl: undefined, requestOrigin: "https://c.test" }), { address: "https://c.test", source: "request" });
  });

  it("falls back to no address rather than a made-up one", () => {
    assert.deepEqual(resolveApiAddress({ saved: null, publicUrl: undefined, requestOrigin: null }), { address: null, source: "none" });
  });
});

describe("serviceEndpoints", () => {
  const manifest = {
    scopes: [
      { key: "things.read", label: "Read things" },
      { key: "things.write", label: "Change things" },
    ],
    pages: [
      { path: "/things", entry: "./a.tsx", kind: "page" },
      { path: "/svc/things/list", entry: "./b.ts", kind: "route", scope: "things.read" },
      { path: "/svc/things/create", entry: "./c.ts", kind: "route", methods: ["POST"], scope: "things.write" },
      { path: "/things/save", entry: "./d.ts", kind: "route", methods: ["POST"], permission: "things.write" },
      { path: "/svc/things/one/[id]", entry: "./e.ts", kind: "route", methods: ["GET", "DELETE"], scope: "things.read" },
    ],
  } as never;

  it("lists only the routes a service token can call, with their method and scope", () => {
    assert.deepEqual(serviceEndpoints(manifest), [
      { method: "POST", path: "/svc/things/create", scope: "things.write", scopeLabel: "Change things" },
      { method: "GET", path: "/svc/things/list", scope: "things.read", scopeLabel: "Read things" },
      { method: "DELETE", path: "/svc/things/one/[id]", scope: "things.read", scopeLabel: "Read things" },
      { method: "GET", path: "/svc/things/one/[id]", scope: "things.read", scopeLabel: "Read things" },
    ]);
  });

  it("is empty for a module with no service routes", () => {
    assert.deepEqual(serviceEndpoints({ pages: [{ path: "/x", entry: "./x.tsx", kind: "page" }] } as never), []);
    assert.deepEqual(serviceEndpoints({} as never), []);
  });
});
