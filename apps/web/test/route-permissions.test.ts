import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { permissionRules, requiredPermissions } from "../src/server/route-permissions.ts";

const mod = (pages: { path: string; permission?: string }[], nav: { href: string; permission?: string }[] = []) => ({ id: "m", pages, nav });
const needs = (pathname: string, rules: ReturnType<typeof permissionRules>) => requiredPermissions(pathname, rules).sort();

describe("permissionRules and requiredPermissions", () => {
  it("covers a page's own route, and only that route", () => {
    const rules = permissionRules([mod([{ path: "/reports/export", permission: "reports.export" }, { path: "/reports" }])]);
    assert.deepEqual(needs("/reports/export", rules), ["reports.export"]);
    assert.deepEqual(needs("/reports/export/", rules), ["reports.export"]);
    assert.deepEqual(needs("/reports", rules), []);
    assert.deepEqual(needs("/reports/export/2026", rules), []);
    assert.deepEqual(needs("/reportsx", rules), []);
  });

  it("matches dynamic segments, catch-all segments and optional catch-all segments", () => {
    const rules = permissionRules([
      mod([
        { path: "/a/[id]/edit", permission: "p.id" },
        { path: "/b/[...rest]", permission: "p.rest" },
        { path: "/c/[[...rest]]", permission: "p.optional" },
      ]),
    ]);
    assert.deepEqual(needs("/a/42/edit", rules), ["p.id"]);
    assert.deepEqual(needs("/a/42", rules), []);
    assert.deepEqual(needs("/a/42/edit/more", rules), []);
    assert.deepEqual(needs("/b/x", rules), ["p.rest"]);
    assert.deepEqual(needs("/b/x/y/z", rules), ["p.rest"]);
    assert.deepEqual(needs("/b", rules), []);
    assert.deepEqual(needs("/c", rules), ["p.optional"]);
    assert.deepEqual(needs("/c/x/y", rules), ["p.optional"]);
  });

  it("makes a navigation entry's permission cover its href and everything below it", () => {
    const rules = permissionRules([mod([], [{ href: "/finance", permission: "finance.read" }, { href: "/open" }])]);
    assert.deepEqual(needs("/finance", rules), ["finance.read"]);
    assert.deepEqual(needs("/finance/ledger/2026", rules), ["finance.read"]);
    assert.deepEqual(needs("/financex", rules), []);
    assert.deepEqual(needs("/open/anything", rules), []);
  });

  it("ignores a query or fragment on a navigation href, and links that are not paths of this app", () => {
    const rules = permissionRules([mod([], [{ href: "/finance?tab=ledger#top", permission: "finance.read" }, { href: "https://example.com", permission: "x" }, { href: "relative", permission: "y" }])]);
    assert.deepEqual(needs("/finance/ledger", rules), ["finance.read"]);
    assert.deepEqual(needs("/relative", rules), []);
  });

  it("asks for every permission that covers a path", () => {
    const rules = permissionRules([mod([{ path: "/finance/ledger", permission: "ledger.read" }], [{ href: "/finance", permission: "finance.read" }])]);
    assert.deepEqual(needs("/finance/ledger", rules), ["finance.read", "ledger.read"]);
    assert.deepEqual(needs("/finance/summary", rules), ["finance.read"]);
  });

  it("collapses repeated slashes and is case sensitive like the router", () => {
    const rules = permissionRules([mod([{ path: "/reports/export", permission: "p" }])]);
    assert.deepEqual(needs("//reports//export", rules), ["p"]);
    assert.deepEqual(needs("/Reports/Export", rules), []);
  });

  it("is empty for a registry with no permissions, and for the root", () => {
    assert.deepEqual(permissionRules([mod([{ path: "/x" }])]), []);
    assert.deepEqual(needs("/", permissionRules([mod([{ path: "/x", permission: "p" }])])), []);
  });
});
