import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateManifest } from "../src/index.ts";

const base = {
  id: "reports",
  version: "1.2.0",
  name: "Reports",
  platform: "^0.1.0",
  dependsOn: {},
  schema: "reports",
  migrationsDir: "migrations",
  nav: [{ label: "Reports", href: "/reports" }],
};

const full = {
  ...base,
  nav: [{ label: "Reports", href: "/reports", group: "Analytics", order: 10, permission: "reports.read" }],
  pages: [
    { path: "/reports", entry: "./src/pages/index.tsx", kind: "page" },
    { path: "/api/reports", entry: "./src/api/list.ts", kind: "route" },
  ],
  settings: [
    { key: "default_range", label: "Default range", type: "select", options: ["7d", "30d"], default: "7d", required: true },
    { key: "api_key", label: "API key", type: "secret", description: "Token for the upstream service" },
    { key: "export_dir", label: "Export directory", type: "path", default: "./exports" },
    { key: "page_size", label: "Page size", type: "number", default: 50 },
    { key: "enabled_beta", label: "Beta", type: "boolean", default: false },
    { key: "title", label: "Title", type: "string" },
  ],
  permissions: [{ key: "reports.read", label: "Read reports" }],
  hooks: "./src/hooks.ts",
};

describe("validateManifest: v2 sections", () => {
  it("accepts a manifest using every v2 section", () => {
    const manifest = validateManifest(full);
    assert.equal(manifest.pages?.length, 2);
    assert.equal(manifest.nav[0]?.permission, "reports.read");
    assert.equal(manifest.hooks, "./src/hooks.ts");
  });

  it("accepts a manifest without the optional sections", () => {
    const manifest = validateManifest(base);
    assert.equal(manifest.pages, undefined);
    assert.equal(manifest.settings, undefined);
  });

  it("validates nav group, order and permission", () => {
    const nav = (entry: object) => ({ ...full, nav: [{ label: "R", href: "/r", ...entry }] });
    assert.throws(() => validateManifest(nav({ group: "" })), /nav\[0\]\.group/);
    assert.throws(() => validateManifest(nav({ order: "1" })), /nav\[0\]\.order must be a finite number/);
    assert.throws(() => validateManifest(nav({ order: Number.NaN })), /nav\[0\]\.order/);
    assert.throws(() => validateManifest(nav({ permission: "reports.write" })), /nav\[0\]\.permission "reports.write" is not a declared permission/);
  });

  it("rejects a nav permission when no permissions are declared", () => {
    const input = { ...base, nav: [{ label: "R", href: "/r", permission: "reports.read" }] };
    assert.throws(() => validateManifest(input), /not a declared permission/);
  });

  it("validates pages", () => {
    const withPages = (pages: unknown) => ({ ...base, pages });
    assert.throws(() => validateManifest(withPages("x")), /pages must be an array/);
    assert.throws(() => validateManifest(withPages([{ path: "x", entry: "./a.tsx", kind: "page" }])), /pages\[0\]\.path must start with "\/"/);
    for (const entry of ["a.tsx", "../a.tsx", "/abs/a.tsx", ""]) {
      assert.throws(() => validateManifest(withPages([{ path: "/x", entry, kind: "page" }])), /pages\[0\]\.entry must be a relative path starting with "\.\/"/, entry);
    }
    assert.throws(() => validateManifest(withPages([{ path: "/x", entry: "./a.tsx", kind: "layout" }])), /pages\[0\]\.kind must be "page" or "route"/);
    assert.throws(
      () => validateManifest(withPages([{ path: "/x", entry: "./a.tsx", kind: "page" }, { path: "/x", entry: "./b.tsx", kind: "route" }])),
      /pages\[1\]\.path "\/x" is duplicated/,
    );
    assert.throws(() => validateManifest(withPages([{ path: "/x", entry: "./a.tsx", kind: "page", extra: 1 }])), /pages\[0\] has unknown field "extra"/);
  });

  it("validates setting keys and types", () => {
    const withSettings = (settings: unknown) => ({ ...base, settings });
    const setting = (extra: object) => withSettings([{ key: "k", label: "K", type: "string", ...extra }]);
    assert.throws(() => validateManifest(withSettings({})), /settings must be an array/);
    for (const key of ["Bad", "1x", "a-b", "", "a..b"]) {
      assert.throws(() => validateManifest(setting({ key })), /settings\[0\]\.key must be a stable identifier/, key);
    }
    assert.throws(() => validateManifest(setting({ type: "color" })), /settings\[0\]\.type must be one of/);
    assert.throws(() => validateManifest(setting({ label: " " })), /settings\[0\]\.label/);
    assert.throws(() => validateManifest(setting({ required: "yes" })), /settings\[0\]\.required must be a boolean/);
    assert.throws(() => validateManifest(setting({ description: 3 })), /settings\[0\]\.description/);
    assert.throws(() => validateManifest(setting({ nope: 1 })), /settings\[0\] has unknown field "nope"/);
    assert.throws(
      () => validateManifest(withSettings([{ key: "k", label: "A", type: "string" }, { key: "k", label: "B", type: "string" }])),
      /settings\[1\]\.key "k" is duplicated/,
    );
  });

  it("validates select options", () => {
    const select = (extra: object) => ({ ...base, settings: [{ key: "k", label: "K", type: "select", ...extra }] });
    assert.throws(() => validateManifest(select({})), /settings\[0\]\.options must be a non-empty array/);
    assert.throws(() => validateManifest(select({ options: [] })), /settings\[0\]\.options must be a non-empty array/);
    assert.throws(() => validateManifest(select({ options: ["a", 2] })), /settings\[0\]\.options must be a non-empty array of non-empty strings/);
    assert.throws(() => validateManifest(select({ options: ["a"], default: "b" })), /settings\[0\]\.default must be one of the options/);
    const notSelect = { ...base, settings: [{ key: "k", label: "K", type: "string", options: ["a"] }] };
    assert.throws(() => validateManifest(notSelect), /settings\[0\]\.options is only allowed for type "select"/);
  });

  it("validates setting defaults against their type", () => {
    const typed = (type: string, def: unknown) => ({ ...base, settings: [{ key: "k", label: "K", type, default: def }] });
    assert.throws(() => validateManifest(typed("number", "5")), /settings\[0\]\.default must be a number/);
    assert.throws(() => validateManifest(typed("boolean", "true")), /settings\[0\]\.default must be a boolean/);
    assert.throws(() => validateManifest(typed("string", 1)), /settings\[0\]\.default must be a string/);
    assert.throws(() => validateManifest(typed("path", 1)), /settings\[0\]\.default must be a string/);
  });

  it("never allows a secret to declare a default", () => {
    const secret = { ...base, settings: [{ key: "k", label: "K", type: "secret", default: "hunter2" }] };
    assert.throws(() => validateManifest(secret), /settings\[0\]\.default is not allowed for type "secret"/);
  });

  it("validates permissions", () => {
    const withPermissions = (permissions: unknown) => ({ ...base, permissions });
    assert.throws(() => validateManifest(withPermissions("x")), /permissions must be an array/);
    assert.throws(() => validateManifest(withPermissions([{ key: "Bad", label: "X" }])), /permissions\[0\]\.key must be a stable identifier/);
    assert.throws(() => validateManifest(withPermissions([{ key: "a.b", label: "" }])), /permissions\[0\]\.label/);
    assert.throws(() => validateManifest(withPermissions([{ key: "a.b", label: "X", extra: 1 }])), /permissions\[0\] has unknown field "extra"/);
    assert.throws(
      () => validateManifest(withPermissions([{ key: "a.b", label: "X" }, { key: "a.b", label: "Y" }])),
      /permissions\[1\]\.key "a.b" is duplicated/,
    );
  });

  it("validates hooks as a relative entry path", () => {
    for (const hooks of ["hooks.ts", "../hooks.ts", "", 1]) {
      assert.throws(() => validateManifest({ ...base, hooks }), /hooks must be a relative path starting with "\.\/"/, String(hooks));
    }
  });
});
