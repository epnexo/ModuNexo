import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ManifestError, validateManifest } from "../src/index.ts";

const base = {
  id: "inbox",
  version: "1.0.0",
  name: "Inbox",
  platform: "^0.1.0",
  dependsOn: {},
  schema: "inbox",
  migrationsDir: "migrations",
  nav: [],
  permissions: [{ key: "inbox.read", label: "Read" }],
  scopes: [
    { key: "messages.read", label: "Read messages" },
    { key: "messages.send", label: "Send messages" },
  ],
};

const scoped = (extra: Record<string, unknown> = {}, top: Record<string, unknown> = {}) => ({
  ...base,
  ...top,
  pages: [{ path: "/svc/inbox/messages", entry: "./web/messages.ts", kind: "route", methods: ["GET"], scope: "messages.read", ...extra }],
});

const problemsOf = (input: unknown): string[] => {
  try {
    validateManifest(input);
  } catch (error) {
    assert.ok(error instanceof ManifestError);
    return error.problems;
  }
  return [];
};

describe("validateManifest: scopes", () => {
  it("accepts declared scopes and a route that requires one", () => {
    assert.deepEqual(problemsOf(scoped()), []);
  });

  it("accepts a module with no scopes at all", () => {
    const { scopes: _scopes, ...without } = base;
    assert.deepEqual(problemsOf(without), []);
  });

  it("requires scopes to be an array of objects with a stable key and a label", () => {
    for (const [scopes, expected] of [
      ["messages.read", "scopes must be an array"],
      [[{ key: "Bad Key", label: "x" }], "scopes[0].key"],
      [[{ key: "a.b", label: "" }], "scopes[0].label"],
      [[{ key: "a.b" }], "scopes[0].label"],
      [[{ key: "a.b", label: "x", extra: 1 }], "unknown field"],
      [[{ key: "a.b", label: "x" }, { key: "a.b", label: "y" }], "duplicated"],
    ] as Array<[unknown, string]>) {
      const problems = problemsOf({ ...base, scopes });
      assert.ok(problems.some((p) => p.includes(expected)), `${JSON.stringify(scopes)}: ${problems.join("\n")}`);
    }
  });

  it("refuses a route scope that is not a declared scope", () => {
    const problems = problemsOf(scoped({ scope: "messages.delete" }));
    assert.ok(problems.some((p) => p.includes('"messages.delete"') && p.includes("scope")), problems.join("\n"));
  });

  it("does not take a permission for a scope", () => {
    const problems = problemsOf(scoped({ scope: "inbox.read" }));
    assert.ok(problems.some((p) => p.includes('"inbox.read"') && p.includes("scope")), problems.join("\n"));
  });

  it("allows scope only on a route", () => {
    const problems = problemsOf(scoped({ kind: "page", methods: undefined }));
    assert.ok(problems.some((p) => p.includes('.scope is only allowed for kind "route"')), problems.join("\n"));
  });

  it("does not combine scope with permission or with public", () => {
    const withPermission = problemsOf(scoped({ permission: "inbox.read" }));
    assert.ok(withPermission.some((p) => p.includes("scope") && p.includes("permission") && p.includes("cannot")), withPermission.join("\n"));
    const withPublic = problemsOf(
      scoped(
        { public: { signature: { secret: "k", header: "x-sig" } } },
        { settings: [{ key: "k", label: "K", type: "secret" }] },
      ),
    );
    assert.ok(withPublic.some((p) => p.includes("scope") && p.includes("public") && p.includes("cannot")), withPublic.join("\n"));
  });

  it("requires the path to sit under /svc/<its own module id>/", () => {
    for (const path of ["/inbox/messages", "/svc/other/messages", "/svc/inbox", "/svc/inbox/", "/svc", "/hooks/inbox/messages"]) {
      const problems = problemsOf(scoped({ path }));
      assert.ok(problems.some((p) => p.includes("/svc/inbox/")), `${path}: ${problems.join("\n")}`);
    }
  });

  it("keeps routes that are not scoped out of /svc", () => {
    const manifest = { ...base, pages: [{ path: "/svc/inbox/open", entry: "./web/open.ts", kind: "route", methods: ["GET"] }] };
    const problems = problemsOf(manifest);
    assert.ok(problems.some((p) => p.includes("/svc") && p.includes("scoped")), problems.join("\n"));
    const page = problemsOf({ ...base, pages: [{ path: "/svc/inbox/panel", entry: "./web/panel.tsx", kind: "page" }] });
    assert.ok(page.some((p) => p.includes("/svc")), page.join("\n"));
  });

  it("keeps a public route out of /svc", () => {
    const problems = problemsOf({
      ...base,
      settings: [{ key: "k", label: "K", type: "secret" }],
      pages: [{ path: "/svc/inbox/hook", entry: "./web/h.ts", kind: "route", methods: ["POST"], public: { signature: { secret: "k", header: "x-sig" } } }],
    });
    assert.ok(problems.some((p) => p.includes("/hooks/inbox/")), problems.join("\n"));
  });

  it("allows any method on a scoped route, since a token can carry a GET", () => {
    assert.deepEqual(problemsOf(scoped({ methods: ["GET", "POST", "DELETE"] })), []);
    assert.deepEqual(problemsOf(scoped({ methods: undefined })), []);
  });
});

describe("validateManifest: existing pages keep working next to scopes", () => {
  it("accepts a plain page, a permissioned route and a scoped route in one manifest", () => {
    const manifest = {
      ...base,
      pages: [
        { path: "/inbox", entry: "./web/page.tsx", kind: "page", permission: "inbox.read" },
        { path: "/inbox/export", entry: "./web/export.ts", kind: "route", methods: ["GET"], permission: "inbox.read" },
        { path: "/svc/inbox/messages", entry: "./web/messages.ts", kind: "route", scope: "messages.read" },
      ],
    };
    assert.deepEqual(problemsOf(manifest), []);
  });
});
