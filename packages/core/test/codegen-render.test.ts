import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SDK_VERSION, type ModuleManifest, type PageDeclaration } from "@modunexo/sdk";
import { GENERATED_HEADER, REGISTRY_FILE, RESERVED_PATHS, RegistrationError, type RegistrationModule, renderRegistration } from "../src/codegen/render.ts";

/** A neutral fixture module; `packageName` defaults to a scoped name derived from the id. */
function fixture(id: string, extra: Partial<ModuleManifest> = {}, packageName = `@fixture/${id}`): RegistrationModule {
  const manifest: ModuleManifest = {
    id,
    version: "1.0.0",
    name: id,
    platform: `^${SDK_VERSION}`,
    dependsOn: {},
    schema: id.replaceAll("-", "_"),
    migrationsDir: "migrations",
    nav: [],
    ...extra,
  };
  return { manifest, packageName };
}

const page = (path: string, entry = "./web/page.tsx", extra: Partial<PageDeclaration> = {}): PageDeclaration => ({ path, entry, kind: "page", ...extra });
const route = (path: string, entry = "./web/handler.ts", extra: Partial<PageDeclaration> = {}): PageDeclaration => ({ path, entry, kind: "route", ...extra });

const render = (modules: RegistrationModule[]) => renderRegistration(modules);
const fileMap = (modules: RegistrationModule[]) => new Map(render(modules).files.map((f) => [f.path, f.content]));
const problemsOf = (modules: RegistrationModule[]): string[] => {
  try {
    render(modules);
  } catch (error) {
    assert.ok(error instanceof RegistrationError, String(error));
    return error.problems;
  }
  return assert.fail("expected a RegistrationError");
};

describe("renderRegistration: registry file", () => {
  it("with no modules exports empty arrays and nothing else is generated", () => {
    const { files, packages } = render([]);
    assert.deepEqual(files.map((f) => f.path), [REGISTRY_FILE]);
    assert.deepEqual(packages, []);
    const content = files[0]!.content;
    assert.match(content, /export const modules: readonly ModuleManifest\[\] = \[\];/);
    assert.match(content, /export const navigation: readonly RegisteredNavEntry\[\] = \[\];/);
    assert.match(content, /export const packageNames: readonly string\[\] = \[\];/);
    assert.doesNotMatch(content, /^import module/m, "no manifest is imported");
  });

  it("starts every generated file with the header", () => {
    const files = render([fixture("alpha", { pages: [page("/alpha"), route("/alpha/data")] })]).files;
    assert.equal(files.length, 3);
    for (const file of files) {
      assert.ok(file.content.startsWith(GENERATED_HEADER), file.path);
    }
    assert.match(GENERATED_HEADER, /GENERATED/);
    assert.match(GENERATED_HEADER, /do not edit/i);
    assert.match(GENERATED_HEADER, /@modunexo\/core/);
  });

  it("imports each manifest through its package and lists them in dependency order", () => {
    const content = fileMap([fixture("zeta"), fixture("alpha", { dependsOn: { zeta: "*" } }), fixture("mid")]).get(REGISTRY_FILE)!;
    assert.match(content, /import module0 from "@fixture\/mid\/manifest";/);
    assert.match(content, /import module1 from "@fixture\/zeta\/manifest";/);
    assert.match(content, /import module2 from "@fixture\/alpha\/manifest";/);
    assert.match(content, /export const modules: readonly ModuleManifest\[\] = \[module0, module1, module2\];/);
  });

  it("lists the package names for the bundler in the same order, in the file and in the result", () => {
    const modules = [fixture("beta", { dependsOn: { alpha: "*" } }, "fixture-beta"), fixture("alpha", {}, "@fixture/alpha")];
    const output = render(modules);
    assert.deepEqual(output.packages, ["@fixture/alpha", "fixture-beta"]);
    assert.match(output.files[0]!.content, /export const packageNames: readonly string\[\] = \["@fixture\/alpha", "fixture-beta"\];/);
  });

  it("flattens navigation: ungrouped first, then groups, each by order (unordered last), then label, carrying the permission", () => {
    const content = fileMap([
      fixture("alpha", {
        permissions: [{ key: "reports.read", label: "Read reports" }],
        nav: [
          { label: "Zulu", href: "/zulu", group: "Tools", order: 2 },
          { label: "Reports", href: "/reports", group: "Analytics", order: 10, permission: "reports.read", icon: "chart" },
          { label: "Home", href: "/home" },
          { label: "Unordered", href: "/unordered", group: "Analytics" },
        ],
      }),
      fixture("beta", { nav: [{ label: "Alpha tool", href: "/beta", group: "Tools", order: 1 }, { label: "Another", href: "/another", group: "Tools", order: 2 }] }),
    ]).get(REGISTRY_FILE)!;
    const entries = [...content.matchAll(/^  (\{"moduleId".*\}),$/gm)].map((m) => JSON.parse(m[1]!) as Record<string, unknown>);
    assert.deepEqual(entries.map((e) => e.href), ["/home", "/reports", "/unordered", "/beta", "/another", "/zulu"]);
    assert.deepEqual(entries[1], { moduleId: "alpha", label: "Reports", href: "/reports", icon: "chart", group: "Analytics", order: 10, permission: "reports.read" });
    assert.deepEqual(entries[0], { moduleId: "alpha", label: "Home", href: "/home" });
  });
});

describe("renderRegistration: route files", () => {
  it("writes a page file that re-exports the default export and metadata from the entry", () => {
    const files = fileMap([fixture("alpha", { pages: [page("/alpha/reports/[id]", "./web/report.tsx")] })]);
    const content = files.get("src/app/(shell)/alpha/reports/[id]/page.tsx")!;
    assert.ok(content.startsWith(GENERATED_HEADER));
    assert.match(content, /^export \{ default, metadata \} from "@fixture\/alpha\/web\/report";$/m);
    assert.doesNotMatch(content, /export const dynamic/);
  });

  it("writes a route file that re-exports the declared methods, GET by default", () => {
    const files = fileMap([
      fixture("alpha", { pages: [route("/alpha/export"), route("/alpha/items", "./web/items.ts", { methods: ["POST", "GET"] })] }),
    ]);
    assert.match(files.get("src/app/(shell)/alpha/export/route.ts")!, /^export \{ GET \} from "@fixture\/alpha\/web\/handler";$/m);
    assert.match(files.get("src/app/(shell)/alpha/items/route.ts")!, /^export \{ POST, GET \} from "@fixture\/alpha\/web\/items";$/m);
  });

  it("writes segment config literally, never as a re-export", () => {
    const files = fileMap([fixture("alpha", { pages: [page("/alpha", "./p.tsx", { dynamic: "force-dynamic" }), route("/alpha/r", "./r.ts", { dynamic: "force-static" })] })]);
    assert.match(files.get("src/app/(shell)/alpha/page.tsx")!, /^export const dynamic = "force-dynamic";$/m);
    assert.match(files.get("src/app/(shell)/alpha/r/route.ts")!, /^export const dynamic = "force-static";$/m);
  });

  it("keeps an entry's extension out of the import and a trailing slash out of the path", () => {
    const files = fileMap([fixture("alpha", { pages: [page("/alpha/", "./web/index.ts"), page("/alpha/b", "./web/b.mjs")] })]);
    assert.match(files.get("src/app/(shell)/alpha/page.tsx")!, /from "@fixture\/alpha\/web\/index";/);
    assert.match(files.get("src/app/(shell)/alpha/b/page.tsx")!, /from "@fixture\/alpha\/web\/b";/);
  });

  it("supports catch-all segments", () => {
    const files = fileMap([fixture("alpha", { pages: [page("/alpha/[...slug]"), page("/alpha/docs/[[...rest]]")] })]);
    assert.ok(files.has("src/app/(shell)/alpha/[...slug]/page.tsx"));
    assert.ok(files.has("src/app/(shell)/alpha/docs/[[...rest]]/page.tsx"));
  });
});

describe("renderRegistration: conflicts are found before anything is produced", () => {
  it("rejects two modules declaring the same normalised path, whatever the kind", () => {
    const problems = problemsOf([fixture("alpha", { pages: [page("/shared/")] }), fixture("beta", { pages: [route("/shared")] })]);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /module "beta" declares "\/shared", which module "alpha" already declares/);
  });

  it("rejects dynamic segments with different names at the same position, naming both modules and both paths", () => {
    const problems = problemsOf([fixture("alpha", { pages: [page("/x/[id]")] }), fixture("beta", { pages: [page("/x/[slug]/edit"), page("/x/[slug]")] })]);
    assert.ok(problems.some((p) => /module "beta" declares "\/x\/\[slug\]\/edit".*"\[slug\]".*module "alpha" declares "\/x\/\[id\]".*"\[id\]"/.test(p)), problems.join("\n"));
  });

  it("rejects differently named dynamic segments even when one path is deeper than the other", () => {
    const problems = problemsOf([fixture("alpha", { pages: [page("/items/[id]")] }), fixture("beta", { pages: [page("/items/[itemId]/notes")] })]);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /module "beta" declares "\/items\/\[itemId\]\/notes".*module "alpha" declares "\/items\/\[id\]"/);
    // The deeper path may come first, and a conflict further down the path is found too.
    assert.equal(problemsOf([fixture("alpha", { pages: [page("/items/[itemId]/notes/[n]")] }), fixture("beta", { pages: [page("/items/[itemId]/notes/[m]")] })]).length, 1);
    assert.equal(problemsOf([fixture("alpha", { pages: [page("/items/[a]/notes")] }), fixture("beta", { pages: [page("/items/[b]/tags")] })]).length, 1);
  });

  it("accepts the same dynamic segment name at that position, and different names under different parents or kinds", () => {
    const modules = [
      fixture("alpha", { pages: [page("/items/[id]"), page("/other/[x]"), page("/docs/[...slug]")] }),
      fixture("beta", { pages: [page("/items/[id]/notes"), page("/more/[y]"), page("/docs/[id]")] }),
    ];
    assert.equal(fileMap(modules).size, 7);
  });

  it("rejects a path that is, or is under, a reserved shell path", () => {
    for (const reserved of RESERVED_PATHS) {
      const path = reserved === "/" ? "/" : `${reserved}/inner`;
      const problems = problemsOf([fixture("alpha", { pages: [page(path)] })]);
      assert.match(problems[0]!, /module "alpha" declares "[^"]+", which is reserved for the shell/, path);
    }
    assert.ok(RESERVED_PATHS.includes("/") && RESERVED_PATHS.includes("/apps") && RESERVED_PATHS.includes("/settings") && RESERVED_PATHS.includes("/login") && RESERVED_PATHS.includes("/api"));
  });

  it("does not treat a longer sibling name as reserved", () => {
    assert.ok(fileMap([fixture("alpha", { pages: [page("/applications"), page("/settings-extra")] })]).has("src/app/(shell)/applications/page.tsx"));
  });

  it("rejects a segment that cannot be a file name, and reports every problem at once", () => {
    const problems = problemsOf([fixture("alpha", { pages: [page("/a/(group)/b"), page("/a/@slot"), page("/a/_private"), page("/apps")] })]);
    assert.equal(problems.filter((p) => /unsupported segment/.test(p)).length, 3);
    assert.ok(problems.some((p) => /reserved/.test(p)));
  });

  it("accepts only balanced dynamic segments: [x], [...x] and [[...x]]", () => {
    for (const ok of ["/a/[x]", "/a/[...x]", "/a/[[...x]]", "/a/[x_1]"]) assert.doesNotThrow(() => render([fixture("alpha", { pages: [page(ok)] })]), ok);
    for (const bad of ["/a/[x]]", "/a/[[...x]", "/a/[[x]]", "/a/[[x]", "/a/[x", "/a/x]", "/a/[...x]]", "/a/[[...x]]]", "/a/[]", "/a/[...]", "/a/[[...]]", "/a/pre[x]"]) {
      // The registry validates each manifest first (the SDK applies the same grammar), so the problem may be its message.
      assert.match(problemsOf([fixture("alpha", { pages: [page(bad)] })])[0]!, /unsupported segment|normalised route path/, bad);
    }
  });

  it("rejects a module with no package name", () => {
    assert.match(problemsOf([fixture("alpha", {}, "")])[0]!, /module "alpha" has no package name/);
  });

  it("rejects two modules with the same package name", () => {
    assert.match(problemsOf([fixture("alpha", {}, "same"), fixture("beta", {}, "same")])[0]!, /package "same" belongs to both module "alpha" and module "beta"/);
  });

  it("reports a dependency problem in the module graph as a registration error", () => {
    assert.match(problemsOf([fixture("alpha", { dependsOn: { missing: "*" } })])[0]!, /depends on unknown module "missing"/);
  });

  it("lets the caller replace the reserved list", () => {
    const modules = [fixture("alpha", { pages: [page("/apps")] })];
    assert.doesNotThrow(() => renderRegistration(modules, { reservedPaths: ["/other"] }));
    assert.throws(() => renderRegistration([fixture("alpha", { pages: [page("/other/x")] })], { reservedPaths: ["/other"] }), RegistrationError);
  });
});
