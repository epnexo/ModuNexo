import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ManifestError, isDynamicRouteSegment, validateManifest } from "../src/index.ts";

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

  it("accepts normalised page paths, including Next.js dynamic segments", () => {
    const paths = ["/", "/reports", "/reports/[id]", "/docs/[...slug]", "/docs/[[...slug]]", "/api/reports/v1"];
    const pages = paths.map((path) => ({ path, entry: "./a.tsx", kind: "page" }));
    assert.equal(validateManifest({ ...base, pages }).pages?.length, paths.length);
  });

  it("rejects page paths that are not normalised", () => {
    const withPath = (path: string) => ({ ...base, pages: [{ path, entry: "./a.tsx", kind: "page" }] });
    for (const path of ["/a//b", "//a", "/a/./b", "/a/../b", "/..", "/a b", "/a\tb", "/a?x=1", "/a#top", "/a/\u00a0", "//", "/a//"]) {
      assert.throws(() => validateManifest(withPath(path)), /pages\[0\]\.path must be a normalised route path/, JSON.stringify(path));
    }
  });

  it("rejects unbalanced or malformed dynamic segments", () => {
    const withPath = (path: string) => ({ ...base, pages: [{ path, entry: "./a.tsx", kind: "page" }] });
    for (const path of ["/a/[x]]", "/a/[[...x]", "/a/[[x]]", "/a/[x", "/a/x]", "/a/[]", "/a/[...]", "/a/pre[x]"]) {
      assert.throws(() => validateManifest(withPath(path)), /pages\[0\]\.path must be a normalised route path/, path);
    }
    assert.equal(isDynamicRouteSegment("[x]") && isDynamicRouteSegment("[...x]") && isDynamicRouteSegment("[[...x]]"), true);
    assert.equal(isDynamicRouteSegment("[x]]") || isDynamicRouteSegment("[[...x]") || isDynamicRouteSegment("x"), false);
  });

  it("treats a trailing slash as the same page path when detecting duplicates", () => {
    const page = (path: string) => ({ path, entry: "./a.tsx", kind: "page" });
    const withPages = (...paths: string[]) => ({ ...base, pages: paths.map(page) });
    assert.throws(() => validateManifest(withPages("/a", "/a/")), /pages\[1\]\.path "\/a\/" is duplicated/);
    assert.throws(() => validateManifest(withPages("/a/", "/a")), /pages\[1\]\.path "\/a" is duplicated/);
    assert.equal(validateManifest(withPages("/", "/a")).pages?.length, 2);
  });

  it("rejects a parent-directory segment inside a relative entry", () => {
    for (const entry of ["./web/../../secrets", "./../a.tsx", "./a/..", "./a/../b.tsx"]) {
      const pages = [{ path: "/x", entry, kind: "page" }];
      assert.throws(() => validateManifest({ ...base, pages }), /pages\[0\]\.entry must be a relative path/, entry);
      assert.throws(() => validateManifest({ ...base, hooks: entry }), /hooks must be a relative path/, entry);
    }
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
    assert.throws(() => validateManifest(typed("number", "5")), /settings\[0\]\.default must be a finite number/);
    assert.throws(() => validateManifest(typed("boolean", "true")), /settings\[0\]\.default must be a boolean/);
    assert.throws(() => validateManifest(typed("string", 1)), /settings\[0\]\.default must be a string/);
    assert.throws(() => validateManifest(typed("path", 1)), /settings\[0\]\.default must be a string/);
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      assert.throws(() => validateManifest(typed("number", value)), /settings\[0\]\.default must be a finite number/, String(value));
    }
    assert.equal(validateManifest(typed("number", -1.5)).settings?.[0]?.default, -1.5);
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

describe("validateManifest: page segment config and route methods", () => {
  const withPage = (page: Record<string, unknown>) => ({ ...base, pages: [{ path: "/x", entry: "./a.tsx", kind: "page", ...page }] });

  it("accepts a rendering mode on a page or a route", () => {
    for (const dynamic of ["auto", "force-dynamic", "force-static", "error"]) {
      assert.equal(validateManifest(withPage({ dynamic })).pages?.[0]?.dynamic, dynamic);
      assert.equal(validateManifest(withPage({ kind: "route", dynamic })).pages?.[0]?.dynamic, dynamic);
    }
  });

  it("rejects a rendering mode Next.js does not know", () => {
    assert.throws(() => validateManifest(withPage({ dynamic: "sometimes" })), /pages\[0\]\.dynamic must be one of auto, force-dynamic, force-static, error/);
    assert.throws(() => validateManifest(withPage({ dynamic: true })), /pages\[0\]\.dynamic must be one of/);
  });

  it("accepts the HTTP methods a route exports", () => {
    const page = validateManifest(withPage({ kind: "route", methods: ["GET", "POST"] })).pages?.[0];
    assert.deepEqual(page?.methods, ["GET", "POST"]);
  });

  it("rejects unknown, repeated or empty methods, and methods on a page", () => {
    assert.throws(() => validateManifest(withPage({ kind: "route", methods: ["FETCH"] })), /pages\[0\]\.methods must be a non-empty array of distinct HTTP methods/);
    assert.throws(() => validateManifest(withPage({ kind: "route", methods: ["GET", "GET"] })), /pages\[0\]\.methods must be a non-empty array of distinct/);
    assert.throws(() => validateManifest(withPage({ kind: "route", methods: [] })), /pages\[0\]\.methods must be a non-empty array/);
    assert.throws(() => validateManifest(withPage({ kind: "page", methods: ["GET"] })), /pages\[0\]\.methods is only allowed for kind "route"/);
  });
});

describe("pages[].permission", () => {
  const base = {
    id: "alpha",
    version: "1.0.0",
    name: "Alpha",
    platform: "^0.1.0",
    dependsOn: {},
    schema: "alpha",
    migrationsDir: "migrations",
    nav: [],
    permissions: [{ key: "reports.read", label: "Read reports" }],
  };

  it("accepts a page that names a permission the manifest declares", () => {
    const manifest = validateManifest({ ...base, pages: [{ path: "/alpha", entry: "./web/page.tsx", kind: "page", permission: "reports.read" }] });
    assert.equal(manifest.pages?.[0]?.permission, "reports.read");
  });

  it("refuses a permission the manifest does not declare, naming the page", () => {
    assert.throws(
      () => validateManifest({ ...base, pages: [{ path: "/alpha", entry: "./web/page.tsx", kind: "page", permission: "reports.write" }] }),
      (error: unknown) => error instanceof ManifestError && /pages\[0\]\.permission "reports\.write" is not a declared permission/.test(error.message),
    );
  });

  it("names the page by its path as well as its index", () => {
    assert.throws(
      () => validateManifest({ ...base, pages: [{ path: "/alpha/reports", entry: "./web/page.tsx", kind: "page", permission: "nope" }] }),
      (error: unknown) => error instanceof ManifestError && /pages\[0\]\.permission "nope" is not a declared permission \(page "\/alpha\/reports"\)/.test(error.message),
    );
  });

  it("refuses a permission on a navigation entry that points at the root, which would cover the whole shell", () => {
    assert.throws(
      () => validateManifest({ ...base, nav: [{ label: "Home", href: "/", permission: "reports.read" }] }),
      (error: unknown) => error instanceof ManifestError && /nav\[0\]\.permission cannot be combined with href "\/"/.test(error.message),
    );
    assert.doesNotThrow(() => validateManifest({ ...base, nav: [{ label: "Home", href: "/" }] }));
    assert.doesNotThrow(() => validateManifest({ ...base, nav: [{ label: "Reports", href: "/reports", permission: "reports.read" }] }));
  });

  it("refuses a permission that is not text", () => {
    assert.throws(() => validateManifest({ ...base, pages: [{ path: "/alpha", entry: "./web/page.tsx", kind: "page", permission: 5 }] }), ManifestError);
  });

  it("refuses a page permission when the manifest declares no permissions at all", () => {
    const { permissions: _unused, ...withoutPermissions } = base;
    assert.throws(() => validateManifest({ ...withoutPermissions, pages: [{ path: "/alpha", entry: "./web/page.tsx", kind: "page", permission: "reports.read" }] }), ManifestError);
  });

  it("leaves a page without a permission as it was", () => {
    const manifest = validateManifest({ ...base, pages: [{ path: "/alpha", entry: "./web/page.tsx", kind: "page" }] });
    assert.equal(manifest.pages?.[0]?.permission, undefined);
  });
});
