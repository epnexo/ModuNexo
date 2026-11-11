import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateManifest } from "../src/index.ts";

const base = {
  id: "docs",
  version: "0.1.0",
  name: "Docs",
  platform: "^0.1.3",
  dependsOn: {},
  schema: "docs",
  migrationsDir: "migrations",
  nav: [{ label: "Docs", href: "/docs" }],
  permissions: [{ key: "docs.write", label: "Write" }],
  pages: [{ path: "/docs/test-engine", entry: "./web/test-engine.ts", kind: "route", methods: ["POST"], permission: "docs.write" }],
};
const check = { key: "engine", label: "Test the engine", path: "/docs/test-engine" };
const withChecks = (checks: unknown, extra: Record<string, unknown> = {}) => ({ ...base, ...extra, checks });
const problems = (input: unknown): string => {
  try {
    validateManifest(input);
  } catch (error) {
    return (error as { problems: string[] }).problems.join(" | ");
  }
  return "";
};

describe("validateManifest: connection checks", () => {
  it("accepts a check that points to a POST route of the module guarded by a permission", () => {
    const manifest = validateManifest(withChecks([{ ...check, description: "Renders a page." }]));
    assert.deepEqual(manifest.checks, [{ ...check, description: "Renders a page." }]);
  });

  it("is optional", () => {
    assert.equal(validateManifest(base).checks, undefined);
  });

  it("must be an array of objects, with at most 8", () => {
    assert.match(problems(withChecks("engine")), /checks must be an array/);
    assert.match(problems(withChecks(["engine"])), /checks\[0\] must be an object/);
    const many = Array.from({ length: 9 }, (_, i) => ({ ...check, key: `c${i}` }));
    assert.match(problems(withChecks(many)), /at most 8/);
  });

  it("refuses unknown fields, a bad key, a blank label, a non-string description and a duplicate key", () => {
    assert.match(problems(withChecks([{ ...check, url: "http://x" }])), /checks\[0\].*unknown field "url"/);
    assert.match(problems(withChecks([{ ...check, key: "Engine!" }])), /checks\[0\]\.key/);
    assert.match(problems(withChecks([{ ...check, label: " " }])), /checks\[0\]\.label/);
    assert.match(problems(withChecks([{ ...check, description: 5 }])), /checks\[0\]\.description/);
    assert.match(problems(withChecks([check, { ...check, path: "/docs/test-engine" }])), /key "engine" is duplicated/);
  });

  it("refuses a path that is not a route the module declares", () => {
    assert.match(problems(withChecks([{ ...check, path: "/docs/other" }])), /checks\[0\]\.path "\/docs\/other" is not a route this module declares in pages/);
    assert.match(problems(withChecks([{ ...check, path: "/api/settings/brand" }])), /is not a route this module declares in pages/);
    assert.match(problems(withChecks([{ ...check, path: 5 }])), /checks\[0\]\.path must be a string/);
    assert.match(problems(withChecks([check], { pages: undefined })), /is not a route this module declares in pages/);
  });

  it("refuses a dynamic route, which has no fixed address to post to", () => {
    const dynamic = { path: "/docs/[id]/test", entry: "./web/t.ts", kind: "route", methods: ["POST"], permission: "docs.write" };
    assert.match(problems(withChecks([{ ...check, path: dynamic.path }], { pages: [dynamic] })), /must not be a dynamic route/);
  });

  it("refuses a route that is a page, does not answer POST, has no permission, is public or takes a scope", () => {
    const route = base.pages[0]!;
    assert.match(problems(withChecks([check], { pages: [{ ...route, kind: "page", methods: undefined }] })), /must be a route/);
    assert.match(problems(withChecks([check], { pages: [{ ...route, methods: ["GET"] }] })), /must answer POST/);
    assert.match(problems(withChecks([check], { pages: [{ ...route, methods: undefined }] })), /must answer POST/);
    assert.match(problems(withChecks([check], { pages: [{ ...route, permission: undefined }] })), /must require a permission/);
    const publicRoute = { path: "/hooks/docs/test-engine", entry: "./a.ts", kind: "route", methods: ["POST"], public: { signature: { secret: "hook_secret", header: "x-sig" } } };
    assert.match(problems(withChecks([{ ...check, path: publicRoute.path }], { pages: [publicRoute], settings: [{ key: "hook_secret", label: "Secret", type: "secret" }] })), /must not be public/);
    const scoped = { path: "/svc/docs/test-engine", entry: "./a.ts", kind: "route", methods: ["POST"], scope: "docs.in" };
    assert.match(problems(withChecks([{ ...check, path: scoped.path }], { scopes: [{ key: "docs.in", label: "In" }], pages: [scoped] })), /must not take a scope/);
  });
});
