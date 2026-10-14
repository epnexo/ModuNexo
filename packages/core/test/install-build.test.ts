import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { SDK_VERSION, type ModuleManifest } from "@epnexo/sdk";
import { REGISTRY_FILE, type RegistrationModule } from "../src/codegen/render.ts";
import { generateRegistration } from "../src/codegen/generate.ts";
import { BuildFailedError, type BuildRunner, buildWithRollback } from "../src/install/build.ts";

let root: string;
const read = (path: string) => readFileSync(join(root, path), "utf8");
const put = (path: string, content: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
};

const module_ = (id: string): RegistrationModule => ({
  packageName: `@fixture/${id}`,
  manifest: { id, version: "1.0.0", name: id, platform: `^${SDK_VERSION}`, dependsOn: {}, schema: id, migrationsDir: "migrations", nav: [], pages: [{ path: `/${id}`, entry: "./web/page.tsx", kind: "page" }] } satisfies ModuleManifest,
});
const before = [module_("alpha")];
const after = [module_("alpha"), module_("beta")];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "epnexo-build-"));
  generateRegistration(before, { outDir: root });
  put(".next/BUILD_ID", "old");
  put(".next/cache/turbo", "warm");
  put(".next/server/page.js", "old page");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const leftovers = () => readdirSync(root).filter((name) => name.includes("rollback"));

const succeeds: BuildRunner = async (webRoot) => {
  assert.match(readFileSync(join(webRoot, REGISTRY_FILE), "utf8"), /beta/, "the build sees the new module registered");
  rmSync(join(webRoot, ".next/server"), { recursive: true, force: true });
  writeFileSync(join(webRoot, ".next/BUILD_ID"), "new");
  return { code: 0, output: "built" };
};
const fails: BuildRunner = async (webRoot) => {
  mkdirSync(join(webRoot, ".next"), { recursive: true });
  rmSync(join(webRoot, ".next/server"), { recursive: true, force: true });
  writeFileSync(join(webRoot, ".next/BUILD_ID"), "half");
  return { code: 1, output: "x".repeat(10) + "Type error: nope" };
};

describe("buildWithRollback", () => {
  it("registers the new module, builds, and keeps the old build until it is committed", async () => {
    const handle = await buildWithRollback({ webRoot: root, modules: after, previousModules: before, run: succeeds });
    assert.equal(read(".next/BUILD_ID"), "new");
    assert.match(read(REGISTRY_FILE), /beta/);
    assert.equal(leftovers().length, 1, "the previous build is kept until commit");
    handle.commit();
    assert.deepEqual(leftovers(), []);
    assert.equal(read(".next/BUILD_ID"), "new");
  });

  it("a failed build restores the previous build and the previous registry and says why", async () => {
    await assert.rejects(buildWithRollback({ webRoot: root, modules: after, previousModules: before, run: fails }), (error) => {
      assert.ok(error instanceof BuildFailedError);
      assert.match(error.output, /Type error: nope/);
      assert.equal(error.code, 1);
      return true;
    });
    assert.equal(read(".next/BUILD_ID"), "old");
    assert.equal(read(".next/server/page.js"), "old page");
    assert.equal(read(".next/cache/turbo"), "warm");
    assert.doesNotMatch(read(REGISTRY_FILE), /beta/);
    assert.deepEqual(leftovers(), []);
  });

  it("a runner that throws is a failed build too", async () => {
    await assert.rejects(
      buildWithRollback({ webRoot: root, modules: after, previousModules: before, run: async () => { throw new Error("spawn failed"); } }),
      /spawn failed/,
    );
    assert.equal(read(".next/BUILD_ID"), "old");
    assert.doesNotMatch(read(REGISTRY_FILE), /beta/);
    assert.deepEqual(leftovers(), []);
  });

  it("rollback after a good build (a later step failed) brings the old build back", async () => {
    const handle = await buildWithRollback({ webRoot: root, modules: after, previousModules: before, run: succeeds });
    handle.rollback();
    assert.equal(read(".next/BUILD_ID"), "old");
    assert.equal(read(".next/server/page.js"), "old page");
    assert.doesNotMatch(read(REGISTRY_FILE), /beta/);
    assert.deepEqual(leftovers(), []);
  });

  it("works when there was no previous build", async () => {
    rmSync(join(root, ".next"), { recursive: true });
    await assert.rejects(buildWithRollback({ webRoot: root, modules: after, previousModules: before, run: fails }), BuildFailedError);
    assert.equal(existsSync(join(root, ".next")), false, "the half build is removed, and none is invented");
    assert.deepEqual(leftovers(), []);
  });
});
