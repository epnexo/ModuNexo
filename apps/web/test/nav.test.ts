import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type NavEntry, groupNavigation, isActive, resolveIcon, subjectCan } from "../src/server/nav.ts";

const entry = (overrides: Partial<NavEntry>): NavEntry => ({ moduleId: "m", label: "Item", href: "/item", ...overrides });
const everything = () => true;

describe("isActive", () => {
  it("matches the home entry only on the root", () => {
    assert.equal(isActive("/", "/"), true);
    assert.equal(isActive("/apps", "/"), false);
  });

  it("matches an entry on its own path and below it, on a segment boundary", () => {
    assert.equal(isActive("/apps", "/apps"), true);
    assert.equal(isActive("/apps/", "/apps"), true);
    assert.equal(isActive("/apps/installed", "/apps"), true);
    assert.equal(isActive("/applications", "/apps"), false);
    assert.equal(isActive("/", "/apps"), false);
  });
});

describe("subjectCan", () => {
  it("lets everyone use an entry that asks for no permission", () => {
    assert.equal(subjectCan({ kind: "user", role: "user" }, undefined), true);
    assert.equal(subjectCan({ kind: "user", role: null }, undefined), true);
  });

  it("gives the local operator and an administrator every permission", () => {
    assert.equal(subjectCan({ kind: "operator" }, "reports.read"), true);
    assert.equal(subjectCan({ kind: "user", role: "admin" }, "reports.read"), true);
  });

  it("gives the operator role every module permission", () => {
    assert.equal(subjectCan({ kind: "user", role: "operator" }, "reports.read"), true);
    assert.equal(subjectCan({ kind: "user", role: "Operator" }, "reports.read"), false);
  });

  it("gives any other role none of the named permissions", () => {
    assert.equal(subjectCan({ kind: "user", role: "user" }, "reports.read"), false);
    assert.equal(subjectCan({ kind: "user", role: null }, "reports.read"), false);
    assert.equal(subjectCan({ kind: "user", role: "ADMIN" }, "reports.read"), false);
  });
});

describe("groupNavigation", () => {
  it("groups consecutive entries under their group label, ungrouped first, keeping the registry's order", () => {
    const groups = groupNavigation(
      [
        entry({ label: "A", href: "/a" }),
        entry({ label: "B", href: "/b", group: "Sales" }),
        entry({ label: "C", href: "/c", group: "Sales" }),
        entry({ label: "D", href: "/d", group: "Tools" }),
      ],
      everything,
    );
    assert.deepEqual(
      groups.map((g) => [g.label, g.entries.map((e) => e.label)]),
      [
        [null, ["A"]],
        ["Sales", ["B", "C"]],
        ["Tools", ["D"]],
      ],
    );
  });

  it("drops the entries a permission hides, and a group left empty", () => {
    const groups = groupNavigation(
      [entry({ label: "A", href: "/a", group: "Sales", permission: "sales.read" }), entry({ label: "B", href: "/b", group: "Tools" })],
      (permission) => permission !== "sales.read",
    );
    assert.deepEqual(groups.map((g) => g.label), ["Tools"]);
  });

  it("returns nothing when there are no entries", () => {
    assert.deepEqual(groupNavigation([], everything), []);
  });
});

describe("resolveIcon", () => {
  it("returns a known icon name as it is", () => {
    assert.equal(resolveIcon("chart"), "chart");
    assert.equal(resolveIcon("home"), "home");
  });

  it("falls back to a generic icon for a name it does not know or no name at all", () => {
    assert.equal(resolveIcon("does-not-exist"), "app");
    assert.equal(resolveIcon(undefined), "app");
    assert.equal(resolveIcon("constructor"), "app");
    assert.equal(resolveIcon("__proto__"), "app");
  });
});
