import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ADMIN_ENTRIES, type NavEntry, arrangeNavigation, groupNavigation, isActive, isAdminPath, resolveIcon, subjectCan } from "../src/server/nav.ts";

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

describe("the Admin block", () => {
  it("holds Apps, Status and Settings, each pointing at the page it always had", () => {
    assert.deepEqual(ADMIN_ENTRIES.map((item) => [item.label, item.href]), [["Apps", "/apps"], ["Groups", "/groups"], ["Status", "/status"], ["Settings", "/settings"]]);
  });

  it("is open on any page inside it, below it included, and closed elsewhere", () => {
    for (const path of ["/apps", "/groups", "/status", "/settings", "/settings/anything", "/apps/x"]) assert.equal(isAdminPath(path), true, path);
    for (const path of ["/", "/inbox", "/applications", "/statuses", "/groupsx"]) assert.equal(isAdminPath(path), false, path);
  });
});

describe("arrangeNavigation: the groups an administrator manages, over the ones manifests declare", () => {
  const layout = {
    groups: [
      { id: 1, name: "Sales", position: 0 },
      { id: 2, name: "Support", position: 1 },
    ],
    assignments: { crm: 2, deals: 1 } as Record<string, number>,
  };
  const labels = (entries: NavEntry[]) => groupNavigation(entries, everything).map((g) => [g.label, g.entries.map((e) => e.label)]);

  it("puts a module under the group it was assigned, whatever its manifest says", () => {
    const entries = [entry({ moduleId: "crm", label: "Contacts", group: "Tools" }), entry({ moduleId: "deals", label: "Deals" })];
    assert.deepEqual(labels(arrangeNavigation(entries, layout)), [
      ["Sales", ["Deals"]],
      ["Support", ["Contacts"]],
    ]);
  });

  it("shows the groups in the administrator's order, not alphabetically", () => {
    const reversed = { ...layout, groups: [{ id: 1, name: "Sales", position: 1 }, { id: 2, name: "Support", position: 0 }] };
    const entries = [entry({ moduleId: "deals", label: "Deals" }), entry({ moduleId: "crm", label: "Contacts" })];
    assert.deepEqual(labels(arrangeNavigation(entries, reversed)).map(([label]) => label), ["Support", "Sales"]);
  });

  it("keeps the manifest's group for a module nobody assigned, after the managed groups, and ungrouped entries first", () => {
    const entries = [
      entry({ moduleId: "crm", label: "Contacts" }),
      entry({ moduleId: "x", label: "Zeta", group: "Zeta tools" }),
      entry({ moduleId: "y", label: "Alpha", group: "Alpha tools" }),
      entry({ moduleId: "z", label: "Loose" }),
    ];
    assert.deepEqual(labels(arrangeNavigation(entries, layout)), [
      [null, ["Loose"]],
      ["Support", ["Contacts"]],
      ["Alpha tools", ["Alpha"]],
      ["Zeta tools", ["Zeta"]],
    ]);
  });

  it("joins a manifest group that has the name of a managed group, ignoring case, into the managed one", () => {
    const entries = [entry({ moduleId: "deals", label: "Deals" }), entry({ moduleId: "other", label: "Quotes", group: "sales" })];
    assert.deepEqual(labels(arrangeNavigation(entries, layout)), [["Sales", ["Deals", "Quotes"]]]);
  });

  it("orders the entries of one group by their order, then label, whichever module they come from", () => {
    const entries = [
      entry({ moduleId: "deals", label: "B", order: 2 }),
      entry({ moduleId: "crm", label: "Z", order: 1 }),
      entry({ moduleId: "deals", label: "A" }),
    ];
    const same = { ...layout, assignments: { crm: 1, deals: 1 } };
    assert.deepEqual(labels(arrangeNavigation(entries, same)), [["Sales", ["Z", "B", "A"]]]);
  });

  it("changes nothing when there are no managed groups", () => {
    const entries = [entry({ label: "A" }), entry({ label: "B", group: "Sales" }), entry({ label: "C", group: "Tools" })];
    assert.deepEqual(arrangeNavigation(entries, { groups: [], assignments: {} }), entries);
  });

  it("falls back to the manifest's group when the assigned group is not in the list", () => {
    const entries = [entry({ moduleId: "crm", label: "Contacts", group: "Tools" })];
    assert.deepEqual(labels(arrangeNavigation(entries, { groups: layout.groups, assignments: { crm: 99 } })), [["Tools", ["Contacts"]]]);
  });
});
