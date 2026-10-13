import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, it } from "node:test";
import { SDK_VERSION, type ModuleManifest, type PageDeclaration } from "@epnexo/sdk";
import { DEFAULT_WEB_ROOT, OWNERSHIP_FILE, generateRegistration } from "../src/codegen/generate.ts";
import { GENERATED_HEADER, REGISTRY_FILE, RegistrationError, type RegistrationModule } from "../src/codegen/render.ts";

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "epnexo-codegen-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function fixture(id: string, pages: PageDeclaration[] = [], extra: Partial<ModuleManifest> = {}): RegistrationModule {
  return {
    packageName: `@fixture/${id}`,
    manifest: { id, version: "1.0.0", name: id, platform: `^${SDK_VERSION}`, dependsOn: {}, schema: id, migrationsDir: "migrations", nav: [], pages, ...extra },
  };
}
const page = (path: string): PageDeclaration => ({ path, entry: "./web/page.tsx", kind: "page" });
const route = (path: string): PageDeclaration => ({ path, entry: "./web/handler.ts", kind: "route" });

const read = (path: string) => readFileSync(join(root, path), "utf8");
const put = (path: string, content: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
};
const generate = (modules: RegistrationModule[], options: { dryRun?: boolean } = {}) => generateRegistration(modules, { outDir: root, ...options });
const ownership = () => JSON.parse(read(OWNERSHIP_FILE)) as { files: string[]; packages: string[] };

describe("generateRegistration: output", () => {
  it("defaults to apps/web at the repository root", () => {
    assert.equal(DEFAULT_WEB_ROOT, join(repoRoot, "apps/web"));
  });

  it("with no modules writes an empty registry and the ownership manifest, and nothing else", () => {
    const plan = generate([]);
    assert.deepEqual(plan.writes.map((w) => [w.path, w.change]), [[REGISTRY_FILE, "create"], [OWNERSHIP_FILE, "create"]]);
    assert.match(read(REGISTRY_FILE), /export const modules: readonly ModuleManifest\[\] = \[\];/);
    assert.deepEqual(ownership(), { generator: "@epnexo/core registry:generate", version: 1, packages: [], files: [REGISTRY_FILE] });
  });

  it("writes the registry, one route file per declared page, and records them in the ownership manifest", () => {
    const plan = generate([fixture("alpha", [page("/alpha"), route("/alpha/export")]), fixture("beta", [page("/beta/[id]")], { dependsOn: { alpha: "*" } })]);
    assert.deepEqual(plan.writes.map((w) => w.path).sort(), [OWNERSHIP_FILE, REGISTRY_FILE, "src/app/(shell)/alpha/export/route.ts", "src/app/(shell)/alpha/page.tsx", "src/app/(shell)/beta/[id]/page.tsx"].sort());
    for (const path of ownership().files) assert.ok(read(path).startsWith(GENERATED_HEADER), path);
    assert.deepEqual(ownership().packages, ["@fixture/alpha", "@fixture/beta"]);
    assert.deepEqual(ownership().files, ["src/app/(shell)/alpha/export/route.ts", "src/app/(shell)/alpha/page.tsx", "src/app/(shell)/beta/[id]/page.tsx", REGISTRY_FILE]);
  });

  it("is idempotent: a second run changes nothing and reports every file as unchanged", () => {
    const modules = [fixture("alpha", [page("/alpha")])];
    generate(modules);
    const second = generate(modules);
    assert.deepEqual(second.writes, []);
    assert.deepEqual(second.deletions, []);
    assert.equal(second.unchanged.length, 3);
  });

  it("updates a generated file whose content must change", () => {
    generate([fixture("alpha", [page("/alpha")])]);
    const plan = generate([fixture("alpha", [{ ...page("/alpha"), dynamic: "force-dynamic" }])]);
    assert.deepEqual(plan.writes.map((w) => [w.path, w.change]), [["src/app/(shell)/alpha/page.tsx", "update"]]);
    assert.match(read("src/app/(shell)/alpha/page.tsx"), /export const dynamic = "force-dynamic";/);
  });
});

describe("generateRegistration: dry run", () => {
  it("returns the planned writes and deletions without touching the filesystem", () => {
    const target = join(root, "not-yet");
    const plan = generateRegistration([fixture("alpha", [page("/alpha")])], { outDir: target, dryRun: true });
    assert.equal(plan.writes.length, 3);
    assert.equal(existsSync(target), false, "not even the output root is created");
  });

  it("plans the deletion of stale files and leaves them in place", () => {
    generate([fixture("alpha", [page("/alpha")])]);
    const plan = generate([], { dryRun: true });
    assert.deepEqual(plan.deletions, ["src/app/(shell)/alpha/page.tsx"]);
    assert.ok(existsSync(join(root, "src/app/(shell)/alpha/page.tsx")));
    assert.equal(ownership().files.length, 2, "the ownership manifest is not rewritten either");
  });
});

describe("generateRegistration: owning its output", () => {
  it("removes the routes of a module that is gone, prunes the folders it emptied, and keeps hand-written files", () => {
    put("src/app/(shell)/custom/page.tsx", "export default function Custom() { return null; }\n");
    generate([fixture("alpha", [page("/alpha/deep/er"), route("/alpha/data")]), fixture("beta", [page("/beta")])]);
    const plan = generate([fixture("beta", [page("/beta")])]);
    assert.deepEqual(plan.deletions, ["src/app/(shell)/alpha/data/route.ts", "src/app/(shell)/alpha/deep/er/page.tsx"]);
    assert.equal(existsSync(join(root, "src/app/(shell)/alpha")), false, "empty folders are removed");
    assert.ok(existsSync(join(root, "src/app/(shell)/beta/page.tsx")));
    assert.ok(existsSync(join(root, "src/app/(shell)/custom/page.tsx")), "a file it did not generate is untouched");
    assert.ok(existsSync(join(root, "src/app/(shell)")), "src/app/(shell) itself stays");
    assert.deepEqual(ownership().files, ["src/app/(shell)/beta/page.tsx", REGISTRY_FILE]);
  });

  it("does not remove a folder that still holds a hand-written file", () => {
    generate([fixture("alpha", [page("/alpha")])]);
    put("src/app/(shell)/alpha/notes.md", "mine\n");
    generate([]);
    assert.equal(existsSync(join(root, "src/app/(shell)/alpha/page.tsx")), false);
    assert.ok(existsSync(join(root, "src/app/(shell)/alpha/notes.md")));
  });

  it("never deletes a listed file that no longer carries the header, and says so", () => {
    generate([fixture("alpha", [page("/alpha")])]);
    put("src/app/(shell)/alpha/page.tsx", "// rewritten by hand\nexport default function A() { return null; }\n");
    const plan = generate([]);
    assert.deepEqual(plan.deletions, []);
    assert.match(plan.warnings[0] ?? "", /src\/app\/\(shell\)\/alpha\/page\.tsx.*not generated.*left in place/);
    assert.ok(read("src/app/(shell)/alpha/page.tsx").startsWith("// rewritten by hand"));
  });

  it("replaces a page by a route at the same path, deleting the old generated file", () => {
    generate([fixture("alpha", [page("/alpha")])]);
    const plan = generate([fixture("alpha", [route("/alpha")])]);
    assert.deepEqual(plan.deletions, ["src/app/(shell)/alpha/page.tsx"]);
    assert.ok(existsSync(join(root, "src/app/(shell)/alpha/route.ts")));
    assert.equal(existsSync(join(root, "src/app/(shell)/alpha/page.tsx")), false);
  });

  it("refuses a path occupied by a hand-written file, and writes nothing at all", () => {
    put("src/app/(shell)/alpha/page.tsx", "export default function Mine() { return null; }\n");
    assert.throws(() => generate([fixture("alpha", [page("/alpha")])]), (error: unknown) => {
      assert.ok(error instanceof RegistrationError);
      assert.match(error.message, /src\/app\/\(shell\)\/alpha\/page\.tsx.*not generated by registry:generate/);
      return true;
    });
    assert.equal(existsSync(join(root, REGISTRY_FILE)), false, "the check happens before the first write");
    assert.equal(read("src/app/(shell)/alpha/page.tsx").includes("Mine"), true);
  });

  it("refuses when a hand-written file of another extension would clash in the same folder", () => {
    put("src/app/(shell)/alpha/page.ts", "export default function Mine() { return null; }\n");
    assert.throws(() => generate([fixture("alpha", [page("/alpha")])]), /src\/app\/\(shell\)\/alpha\/page\.ts.*would clash/);
    put("src/app/(shell)/alpha/route.js", "export const GET = () => null;\n");
    assert.throws(() => generate([fixture("alpha", [page("/alpha")])]), RegistrationError);
  });

  it("refuses a registry path occupied by a hand-written file", () => {
    put(REGISTRY_FILE, "export const modules = [];\n");
    assert.throws(() => generate([]), /src\/generated\/modules\.ts.*not generated/);
  });

  it("refuses when a directory is where a file is needed", () => {
    mkdirSync(join(root, REGISTRY_FILE), { recursive: true });
    assert.throws(() => generate([]), /src\/generated\/modules\.ts.*is a directory/);
  });

  it("refuses an unreadable ownership manifest instead of guessing what it owns", () => {
    put(OWNERSHIP_FILE, "{ not json");
    assert.throws(() => generate([]), /src\/generated\/\.manifest\.json.*not a valid ownership manifest/);
    put(OWNERSHIP_FILE, JSON.stringify({ generator: "@epnexo/core registry:generate", version: 1, files: ["../outside.ts"], packages: [] }));
    assert.throws(() => generate([]), /not a valid ownership manifest/);
  });

  it("finds conflicts before touching anything", () => {
    assert.throws(() => generate([fixture("alpha", [page("/apps")])]), /reserved for the shell/);
    assert.throws(() => generate([fixture("alpha", [page("/x")]), fixture("beta", [page("/x")])]), /already declares/);
    assert.equal(existsSync(join(root, "src")), false);
  });
});

/** Every file and folder under `dir`, relative to it and sorted; folders end with "/". */
function treeOf(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      found.push(`${relative(dir, absolute)}${entry.isDirectory() ? "/" : ""}`);
      if (entry.isDirectory()) walk(absolute);
    }
  };
  walk(dir);
  return found.sort();
}

describe("generateRegistration: a run that fails partway", () => {
  // Permission bits cannot stop the superuser, so those cases are skipped there; the write case needs no permissions.
  const unprivileged = process.getuid?.() !== 0;

  /** The tree a clean run of `modules` produces in an empty folder, plus any hand-written files in `extra`. */
  function cleanTree(modules: RegistrationModule[], extra: Record<string, string> = {}): string[] {
    const fresh = mkdtempSync(join(tmpdir(), "epnexo-codegen-clean-"));
    try {
      for (const [path, content] of Object.entries(extra)) {
        mkdirSync(dirname(join(fresh, path)), { recursive: true });
        writeFileSync(join(fresh, path), content);
      }
      generateRegistration(modules, { outDir: fresh });
      return treeOf(fresh);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  }

  it("leaves nothing orphaned when a write fails: the next run removes what the failed run created", () => {
    const alpha = fixture("alpha", [page("/alpha")]);
    generate([alpha]);
    // "/blocked" is a hand-written file, so the folder a later page needs cannot be created.
    put("src/app/(shell)/blocked", "not a folder\n");
    const beta = fixture("beta", [page("/beta"), page("/blocked/inside")]);
    assert.throws(() => generate([alpha, beta]), /ENOTDIR|EEXIST/);
    assert.ok(existsSync(join(root, "src/app/(shell)/beta/page.tsx")), "the failed run did write the file before the failing one");

    const plan = generate([alpha]);
    assert.deepEqual(plan.deletions, ["src/app/(shell)/beta/page.tsx"]);
    assert.deepEqual(treeOf(root), cleanTree([alpha], { "src/app/(shell)/blocked": "not a folder\n" }));
    assert.deepEqual(ownership().files, ["src/app/(shell)/alpha/page.tsx", REGISTRY_FILE]);
  });

  it("converges after a failed deletion", { skip: !unprivileged && "needs an unprivileged user" }, () => {
    const alpha = fixture("alpha", [page("/alpha")]);
    const beta = fixture("beta", [page("/beta")]);
    generate([alpha, beta]);
    chmodSync(join(root, "src/app/(shell)/alpha"), 0o555);
    try {
      assert.throws(() => generate([beta]), /EACCES|EPERM/);
    } finally {
      chmodSync(join(root, "src/app/(shell)/alpha"), 0o755);
    }
    assert.ok(ownership().files.includes("src/app/(shell)/alpha/page.tsx"), "the interrupted run still records the file it has not removed");

    generate([beta]);
    assert.deepEqual(treeOf(root), cleanTree([beta]));
  });

  it("converges after a failed folder prune, removing the empty folders the interrupted run left", { skip: !unprivileged && "needs an unprivileged user" }, () => {
    const alpha = fixture("alpha", [page("/alpha/deep/er")]);
    const beta = fixture("beta", [page("/beta")]);
    generate([alpha, beta]);
    // The file can be deleted from its own folder, but the folder cannot be removed from its parent.
    chmodSync(join(root, "src/app/(shell)/alpha"), 0o555);
    try {
      assert.throws(() => generate([beta]), /EACCES|EPERM/);
    } finally {
      chmodSync(join(root, "src/app/(shell)/alpha"), 0o755);
    }
    assert.equal(existsSync(join(root, "src/app/(shell)/alpha/deep/er/page.tsx")), false);

    generate([beta]);
    assert.deepEqual(treeOf(root), cleanTree([beta]));
  });

  it("changes nothing on disk when the run has nothing to do", () => {
    const modules = [fixture("alpha", [page("/alpha")])];
    generate(modules);
    const before = readFileSync(join(root, OWNERSHIP_FILE), "utf8");
    generate(modules);
    assert.equal(readFileSync(join(root, OWNERSHIP_FILE), "utf8"), before);
  });
});

describe("the generated registry", () => {
  it("typechecks with no modules", async () => {
    generate([]);
    const tsconfig = join(root, "tsconfig.json");
    writeFileSync(
      tsconfig,
      JSON.stringify({
        extends: join(repoRoot, "tsconfig.base.json"),
        compilerOptions: { typeRoots: [join(repoRoot, "node_modules/@types")], paths: { "@epnexo/sdk": [join(repoRoot, "packages/sdk/src/index.ts")] } },
        files: [join(root, REGISTRY_FILE)],
      }),
    );
    const tsc = join(repoRoot, "node_modules/typescript/bin/tsc");
    await assert.doesNotReject(run(process.execPath, [tsc, "--noEmit", "-p", tsconfig]).catch((error: { stdout?: string }) => Promise.reject(new Error(error.stdout))));
  });

  it("resolves the manifests of the enabled modules through their packages", async () => {
    // Module packages as npm workspaces link them: <root>/node_modules/<package name>/, with manifest.ts at its root.
    for (const id of ["alpha", "beta"]) {
      mkdirSync(join(root, "node_modules/@fixture", id), { recursive: true });
      writeFileSync(
        join(root, "node_modules/@fixture", id, "manifest.ts"),
        `export default { id: "${id}", nav: [{ label: "${id}", href: "/${id}", group: "G", order: ${id === "alpha" ? 2 : 1} }] };\n`,
      );
    }
    const nav = (id: string, order: number) => [{ label: id, href: `/${id}`, group: "G", order }];
    generate([fixture("alpha", [page("/alpha")], { nav: nav("alpha", 2) }), fixture("beta", [], { dependsOn: { alpha: "*" }, nav: nav("beta", 1) })]);
    // An in-process import would be cached by path across runs of this test file, so run it in a child.
    const script = `const m = await import(${JSON.stringify(join(root, REGISTRY_FILE))}); console.log(JSON.stringify({ ids: m.modules.map((x) => x.id), nav: m.navigation.map((n) => n.moduleId), packages: m.packageNames }));`;
    const { stdout } = await run(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: repoRoot });
    assert.deepEqual(JSON.parse(stdout), { ids: ["alpha", "beta"], nav: ["beta", "alpha"], packages: ["@fixture/alpha", "@fixture/beta"] });
  });
});

