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
  settings: [{ key: "webhook_secret", label: "Webhook secret", type: "secret" }],
  permissions: [{ key: "inbox.read", label: "Read" }],
};

const signature = { secret: "webhook_secret", header: "x-signature" };
const publicRoute = (extra: Record<string, unknown> = {}, publicExtra: Record<string, unknown> = {}) => ({
  ...base,
  pages: [
    {
      path: "/hooks/inbox/messages",
      entry: "./web/messages.ts",
      kind: "route",
      methods: ["POST"],
      public: { signature, ...publicExtra },
      ...extra,
    },
  ],
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

describe("validateManifest: public routes", () => {
  it("accepts a public route with a signature, under /hooks/<module-id>/", () => {
    assert.deepEqual(problemsOf(publicRoute()), []);
  });

  it("accepts every optional signature and limit field", () => {
    const manifest = publicRoute(
      {},
      {
        signature: { ...signature, encoding: "base64", prefix: "sha256=", timestampHeader: "x-timestamp", toleranceSeconds: 120 },
        ratePerMinute: 30,
        maxBodyBytes: 4096,
      },
    );
    assert.deepEqual(problemsOf(manifest), []);
  });

  it("requires the signature: a public route without one is an error", () => {
    const problems = problemsOf(publicRoute({}, { signature: undefined }));
    assert.ok(problems.some((p) => p.includes("public.signature") && p.includes("required")), problems.join("\n"));
  });

  it("rejects public as a boolean, so a route cannot be opened by writing true", () => {
    const problems = problemsOf(publicRoute({ public: true }));
    assert.ok(problems.some((p) => p.includes(".public must be an object")), problems.join("\n"));
  });

  it("only allows public on a route, not on a page", () => {
    const problems = problemsOf(publicRoute({ kind: "page", methods: undefined }));
    assert.ok(problems.some((p) => p.includes('.public is only allowed for kind "route"')), problems.join("\n"));
  });

  it("does not combine public with permission", () => {
    const problems = problemsOf(publicRoute({ permission: "inbox.read" }));
    assert.ok(problems.some((p) => p.includes("public") && p.includes("permission") && p.includes("cannot")), problems.join("\n"));
  });

  it("requires the path to sit under /hooks/<its own module id>/", () => {
    for (const path of ["/inbox/messages", "/hooks/other/messages", "/hooks/inbox", "/hooks/inbox/", "/hooks"]) {
      const problems = problemsOf(publicRoute({ path }));
      assert.ok(problems.some((p) => p.includes("/hooks/inbox/")), `${path}: ${problems.join("\n")}`);
    }
  });

  it("keeps non-public pages out of /hooks", () => {
    const manifest = { ...base, pages: [{ path: "/hooks/inbox/admin", entry: "./web/admin.tsx", kind: "page" }] };
    const problems = problemsOf(manifest);
    assert.ok(problems.some((p) => p.includes("/hooks") && p.includes("public")), problems.join("\n"));
  });

  it("requires the secret to name a declared setting of type secret", () => {
    const missing = problemsOf(publicRoute({}, { signature: { ...signature, secret: "nope" } }));
    assert.ok(missing.some((p) => p.includes('"nope"') && p.includes("secret")), missing.join("\n"));
    const wrongType = problemsOf({
      ...publicRoute(),
      settings: [{ key: "webhook_secret", label: "Webhook secret", type: "string" }],
    });
    assert.ok(wrongType.some((p) => p.includes("webhook_secret") && p.includes('type "secret"')), wrongType.join("\n"));
  });

  it("requires explicit methods with a body: GET, HEAD and OPTIONS cannot be public", () => {
    const noMethods = problemsOf(publicRoute({ methods: undefined }));
    assert.ok(noMethods.some((p) => p.includes("methods") && p.includes("public")), noMethods.join("\n"));
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      const problems = problemsOf(publicRoute({ methods: ["POST", method] }));
      assert.ok(problems.some((p) => p.includes(method) && p.includes("public")), `${method}: ${problems.join("\n")}`);
    }
  });

  it("validates the signature fields", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ header: "bad header" }, "signature.header"],
      [{ header: "" }, "signature.header"],
      [{ encoding: "utf8" }, "signature.encoding"],
      [{ prefix: "" }, "signature.prefix"],
      [{ toleranceSeconds: 60 }, "toleranceSeconds"],
      [{ timestampHeader: "x-ts", toleranceSeconds: 0 }, "toleranceSeconds"],
      [{ timestampHeader: "bad header" }, "timestampHeader"],
      [{ unknown: 1 }, "unknown field"],
    ];
    for (const [patch, expected] of cases) {
      const problems = problemsOf(publicRoute({}, { signature: { ...signature, ...patch } }));
      assert.ok(problems.some((p) => p.includes(expected)), `${JSON.stringify(patch)}: ${problems.join("\n")}`);
    }
  });

  it("validates the limits and rejects unknown public fields", () => {
    for (const [patch, expected] of [
      [{ ratePerMinute: 0 }, "ratePerMinute"],
      [{ ratePerMinute: 1.5 }, "ratePerMinute"],
      [{ maxBodyBytes: -1 }, "maxBodyBytes"],
      [{ maxBodyBytes: 100 * 1024 * 1024 }, "maxBodyBytes"],
      [{ open: true }, "unknown field"],
    ] as Array<[Record<string, unknown>, string]>) {
      const problems = problemsOf(publicRoute({}, patch));
      assert.ok(problems.some((p) => p.includes(expected)), `${JSON.stringify(patch)}: ${problems.join("\n")}`);
    }
  });
});

describe("validateManifest: pages without public keep working", () => {
  it("accepts a plain page and a permissioned route as before", () => {
    const manifest = {
      ...base,
      pages: [
        { path: "/inbox", entry: "./web/page.tsx", kind: "page", permission: "inbox.read" },
        { path: "/inbox/export", entry: "./web/export.ts", kind: "route", methods: ["GET"], permission: "inbox.read" },
      ],
    };
    assert.deepEqual(problemsOf(manifest), []);
  });
});
