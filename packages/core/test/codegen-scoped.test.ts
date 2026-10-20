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
    scopes: [{ key: "messages.read", label: "Read messages" }],
    pages,
  };
  return { manifest, packageName: `@fixture/${id}` };
}

const scoped = (path: string, extra: Partial<PageDeclaration> = {}): PageDeclaration => ({ path, entry: "./web/api.ts", kind: "route", scope: "messages.read", ...extra });
const render = (modules: RegistrationModule[]) => new Map(renderRegistration(modules).files.map((f) => [f.path, f.content]));
const FILE = "src/app/(shell)/svc/inbox/messages/route.ts";

describe("renderRegistration: scoped routes", () => {
  it("wraps the handler so the shell checks the token before the module sees the request", () => {
    const content = render([fixture("inbox", [scoped("/svc/inbox/messages")])]).get(FILE);
    assert.ok(content !== undefined);
    assert.match(content, /import \{ scopedRoute \} from "@\/server\/scoped-route";/);
    assert.match(content, /import \* as handlers from "@fixture\/inbox\/web\/api";/);
    assert.match(content, /export const GET = scopedRoute\(rule, handlers\.GET\);/);
    assert.doesNotMatch(content, /export \{ GET \} from/, "the handler is never re-exported bare");
    assert.doesNotMatch(content, /publicRoute/);
  });

  it("writes the module, the path and the required scope into the route file, nothing else", () => {
    const content = render([fixture("inbox", [scoped("/svc/inbox/messages")])]).get(FILE)!;
    assert.match(content, /const rule = \{"moduleId":"inbox","path":"\/svc\/inbox\/messages","scope":"messages.read"\};/);
  });

  it("wraps every declared method, and GET when none is declared", () => {
    const many = render([fixture("inbox", [scoped("/svc/inbox/messages", { methods: ["GET", "POST", "DELETE"] })])]).get(FILE)!;
    for (const m of ["GET", "POST", "DELETE"]) assert.match(many, new RegExp(`export const ${m} = scopedRoute\\(rule, handlers\\.${m}\\);`));
    const none = render([fixture("inbox", [scoped("/svc/inbox/messages")])]).get(FILE)!;
    assert.match(none, /export const GET = scopedRoute/);
    assert.doesNotMatch(none, /export const POST/);
  });

  it("keeps the segment config literal in the route file", () => {
    const content = render([fixture("inbox", [scoped("/svc/inbox/messages", { dynamic: "force-dynamic" })])]).get(FILE)!;
    assert.match(content, /export const dynamic = "force-dynamic";/);
  });

  it("refuses a scoped route outside /svc/<its own module id>/, or one that names an undeclared scope", () => {
    for (const modules of [
      [fixture("inbox", [scoped("/inbox/messages")])],
      [fixture("inbox", [scoped("/svc/other/messages")])],
      [fixture("inbox", [scoped("/svc/inbox/messages", { scope: "messages.delete" })])],
    ]) {
      assert.throws(() => renderRegistration(modules), (e: unknown) => e instanceof RegistrationError);
    }
  });
});
