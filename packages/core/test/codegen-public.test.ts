import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SDK_VERSION, type ModuleManifest, type PageDeclaration } from "@modunexo/sdk";
import { RegistrationError, type RegistrationModule, renderRegistration } from "../src/codegen/render.ts";

function fixture(id: string, pages: PageDeclaration[]): RegistrationModule {
  const manifest: ModuleManifest = {
    id,
    version: "1.0.0",
    name: id,
    platform: `^${SDK_VERSION}`,
    dependsOn: {},
    schema: id.replaceAll("-", "_"),
    migrationsDir: "migrations",
    nav: [],
    settings: [{ key: "webhook_secret", label: "Webhook secret", type: "secret" }],
    pages,
  };
  return { manifest, packageName: `@fixture/${id}` };
}

const publicRoute = (path: string, extra: Partial<PageDeclaration> = {}): PageDeclaration => ({
  path,
  entry: "./web/hook.ts",
  kind: "route",
  methods: ["POST"],
  public: { signature: { secret: "webhook_secret", header: "x-signature" } },
  ...extra,
});

const render = (modules: RegistrationModule[]) => new Map(renderRegistration(modules).files.map((f) => [f.path, f.content]));
const problemsOf = (modules: RegistrationModule[]): string[] => {
  try {
    renderRegistration(modules);
  } catch (error) {
    assert.ok(error instanceof RegistrationError, String(error));
    return error.problems;
  }
  return assert.fail("expected a RegistrationError");
};

describe("renderRegistration: public routes", () => {
  it("wraps the handler so the shell verifies the request before the module sees it", () => {
    const files = render([fixture("inbox", [publicRoute("/hooks/inbox/messages")])]);
    const content = files.get("src/app/(shell)/hooks/inbox/messages/route.ts");
    assert.ok(content !== undefined, [...files.keys()].join("\n"));
    assert.match(content, /import \{ publicRoute, type PublicRouteRule \} from "@\/server\/public-route";/);
    assert.match(content, /import \* as handlers from "@fixture\/inbox\/web\/hook";/);
    assert.match(content, /export const POST = publicRoute\(/);
    assert.match(content, /handlers\.POST/);
    assert.doesNotMatch(content, /export \{ POST \} from/, "the handler is never re-exported unwrapped");
  });

  it("writes the declared rule into the route file, with the module id", () => {
    const content = render([
      fixture("inbox", [publicRoute("/hooks/inbox/messages", { public: { signature: { secret: "webhook_secret", header: "x-hub", prefix: "sha256=" }, ratePerMinute: 5 } })]),
    ]).get("src/app/(shell)/hooks/inbox/messages/route.ts")!;
    assert.match(content, /"moduleId":"inbox"/);
    assert.match(content, /"header":"x-hub"/);
    assert.match(content, /"prefix":"sha256="/);
    assert.match(content, /"ratePerMinute":5/);
  });

  it("types the rule, so a declared encoding stays \"hex\" or \"base64\" and the route file still compiles", () => {
    const content = render([
      fixture("inbox", [publicRoute("/hooks/inbox/messages", { public: { signature: { secret: "webhook_secret", header: "x-signature", encoding: "hex" } } })]),
    ]).get("src/app/(shell)/hooks/inbox/messages/route.ts")!;
    assert.match(content, /import \{ publicRoute, type PublicRouteRule \} from "@\/server\/public-route";/);
    assert.match(content, /const rule: PublicRouteRule = \{/);
    assert.match(content, /"encoding":"hex"/);
  });

  it("wraps every declared method", () => {
    const content = render([fixture("inbox", [publicRoute("/hooks/inbox/messages", { methods: ["POST", "PUT"] })])]).get("src/app/(shell)/hooks/inbox/messages/route.ts")!;
    assert.match(content, /export const POST = publicRoute\(/);
    assert.match(content, /export const PUT = publicRoute\(/);
  });

  it("keeps the segment config literal in the route file", () => {
    const content = render([fixture("inbox", [publicRoute("/hooks/inbox/messages", { dynamic: "force-dynamic" })])]).get("src/app/(shell)/hooks/inbox/messages/route.ts")!;
    assert.match(content, /export const dynamic = "force-dynamic";/);
  });

  it("leaves a non-public route as the plain re-export it always was", () => {
    const content = render([fixture("inbox", [{ path: "/inbox/export", entry: "./web/export.ts", kind: "route", methods: ["GET"] }])]).get("src/app/(shell)/inbox/export/route.ts")!;
    assert.match(content, /export \{ GET \} from "@fixture\/inbox\/web\/export";/);
    assert.doesNotMatch(content, /publicRoute/);
  });

  it("refuses a public route outside /hooks/<its own module id>/", () => {
    const problems = problemsOf([fixture("inbox", [publicRoute("/inbox/messages")])]);
    assert.ok(problems.some((p) => p.includes("/hooks/inbox/") && p.includes("public")), problems.join("\n"));
    const other = problemsOf([fixture("inbox", [publicRoute("/hooks/other/messages")])]);
    assert.ok(other.some((p) => p.includes("/hooks/inbox/")), other.join("\n"));
  });

  it("refuses a page that is not public under /hooks, whatever the module id", () => {
    const problems = problemsOf([fixture("inbox", [{ path: "/hooks/inbox/panel", entry: "./web/panel.tsx", kind: "page" }])]);
    assert.ok(problems.some((p) => p.includes("/hooks") && p.includes("public")), problems.join("\n"));
    const bare = problemsOf([fixture("inbox", [{ path: "/hooks", entry: "./web/panel.tsx", kind: "page" }])]);
    assert.ok(bare.some((p) => p.includes("/hooks")), bare.join("\n"));
  });

  it("refuses a public declaration on a page, not only on a route", () => {
    const problems = problemsOf([fixture("inbox", [publicRoute("/hooks/inbox/panel", { kind: "page", methods: undefined })])]);
    assert.ok(problems.some((p) => p.includes("public") && p.includes("route")), problems.join("\n"));
  });
});
