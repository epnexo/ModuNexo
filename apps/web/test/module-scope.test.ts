import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { moduleForPath, moduleScopes } from "../src/server/module-scope.ts";

const mod = (id: string, pages: string[] = [], nav: string[] = []) => ({ id, pages: pages.map((path) => ({ path })), nav: nav.map((href) => ({ href })) });

describe("moduleScopes", () => {
  it("takes the static prefix of each page path and each navigation href", () => {
    const scopes = moduleScopes([mod("alpha", ["/alpha", "/alpha/export"], ["/alpha"]), mod("beta", ["/beta/[id]/edit"], ["/beta-home"])]);
    assert.deepEqual(scopes, [
      { id: "alpha", prefixes: ["/alpha", "/alpha/export"] },
      { id: "beta", prefixes: ["/beta", "/beta-home"] },
    ]);
  });

  it("cuts a dynamic segment and everything after it, and drops a trailing slash", () => {
    assert.deepEqual(moduleScopes([mod("a", ["/a/x/[id]/y", "/b/"], [])]), [{ id: "a", prefixes: ["/a/x", "/b"] }]);
  });

  it("ignores the root, relative paths and external links", () => {
    assert.deepEqual(moduleScopes([mod("a", ["/"], ["https://example.com", "mailto:x@y.z", "relative", "//cdn.example.com/x", "/ok"])]), [{ id: "a", prefixes: ["/ok"] }]);
  });

  it("returns a module with no usable prefix as an empty scope", () => {
    assert.deepEqual(moduleScopes([mod("a")]), [{ id: "a", prefixes: [] }]);
  });
});

describe("moduleForPath", () => {
  const scopes = [
    { id: "reports", prefixes: ["/reports"] },
    { id: "sales", prefixes: ["/reports/sales"] },
    { id: "docs", prefixes: ["/docs", "/files"] },
  ];

  it("returns the module that owns the path or a path below it", () => {
    assert.equal(moduleForPath("/reports", scopes), "reports");
    assert.equal(moduleForPath("/reports/q3", scopes), "reports");
    assert.equal(moduleForPath("/files/a/b", scopes), "docs");
  });

  it("prefers the longest prefix", () => {
    assert.equal(moduleForPath("/reports/sales", scopes), "sales");
    assert.equal(moduleForPath("/reports/sales/2026", scopes), "sales");
  });

  it("matches on a segment boundary only", () => {
    assert.equal(moduleForPath("/reportsx", scopes), null);
    assert.equal(moduleForPath("/doc", scopes), null);
  });

  it("is null for the shell's own pages, the root and unknown paths", () => {
    for (const path of ["/", "/apps", "/settings", "/nowhere", ""]) assert.equal(moduleForPath(path, scopes), null, path);
  });

  it("ignores a trailing slash on the path", () => {
    assert.equal(moduleForPath("/reports/", scopes), "reports");
  });
});
