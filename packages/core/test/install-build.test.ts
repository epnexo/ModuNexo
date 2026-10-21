import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { SDK_VERSION, type ModuleManifest } from "@modunexo/sdk";
import { REGISTRY_FILE, type RegistrationModule } from "../src/codegen/render.ts";
import { generateRegistration } from "../src/codegen/generate.ts";
import { BuildFailedError, type BuildRunner, buildWithRollback } from "../src/install/build.ts";
import { distRecordPath, readLiveDist, writeLiveDist } from "../src/install/dist.ts";

let root: string;
let dataDir: string;
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
const DIST = ".next-newbuild01";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "modunexo-build-"));
  dataDir = join(root, "var");
  generateRegistration(before, { outDir: root });
  put("tsconfig.json", JSON.stringify({ include: ["src", ".next/types/**/*.ts", ".next/dev/types/**/*.ts"] }));
  put(".next/BUILD_ID", "old");
  put(".next/cache/turbo", "warm");
  put(".next/server/page.js", "old page");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const options = (run: BuildRunner, extra: Record<string, unknown> = {}) => ({ webRoot: root, dataDir, dist: DIST, modules: after, previousModules: before, run, ...extra });
/** Every build directory, tsconfig for one and rollback leftover in the web folder. */
const builds = () => readdirSync(root).filter((name) => name.startsWith(".next") || name.startsWith("tsconfig.next"));
const liveName = () => readLiveDist(root, dataDir).name;

/** What a real build does to the live directory while it runs: nothing. */
const succeeds: BuildRunner = async (webRoot, _signal, dist) => {
  assert.equal(dist, DIST, "the runner is told which directory to write");
  assert.match(readFileSync(join(webRoot, REGISTRY_FILE), "utf8"), /beta/, "the build sees the new module registered");
  assert.equal(readFileSync(join(webRoot, ".next/BUILD_ID"), "utf8"), "old", "the live build is untouched while the new one is made");
  assert.equal(readFileSync(join(webRoot, ".next/server/page.js"), "utf8"), "old page");
  assert.equal(readFileSync(join(webRoot, ".next/cache/turbo"), "utf8"), "warm");
  assert.equal(existsSync(join(webRoot, DIST)), false, "the new build starts from nothing: no cache is shared with another build");
  assert.deepEqual((JSON.parse(readFileSync(join(webRoot, `tsconfig${DIST}.json`), "utf8")) as { include: string[] }).include, ["src", `${DIST}/types/**/*.ts`], "it is type-checked with its own types, not the live build's");
  mkdirSync(join(webRoot, DIST, "server"), { recursive: true });
  writeFileSync(join(webRoot, DIST, "BUILD_ID"), "new");
  return { code: 0, output: "built" };
};
const quick: BuildRunner = async (webRoot, _signal, dist) => {
  mkdirSync(join(webRoot, dist!), { recursive: true });
  writeFileSync(join(webRoot, dist!, "BUILD_ID"), "n");
  return { code: 0, output: "" };
};
const fails: BuildRunner = async (webRoot, _signal, dist) => {
  mkdirSync(join(webRoot, dist!, "server"), { recursive: true });
  writeFileSync(join(webRoot, dist!, "BUILD_ID"), "half");
  return { code: 1, output: "x".repeat(10) + "Type error: nope" };
};

describe("buildWithRollback", () => {
  it("builds beside the live build, leaves it serving, and goes live only at commit", async () => {
    const handle = await buildWithRollback(options(succeeds));
    assert.equal(handle.dist, DIST);
    assert.equal(read(`${DIST}/BUILD_ID`), "new");
    assert.match(read(REGISTRY_FILE), /beta/);
    assert.equal(read(".next/BUILD_ID"), "old");
    assert.equal(liveName(), ".next", "nothing is switched yet: the next steps may still fail");
    assert.equal(existsSync(distRecordPath(dataDir)), false);

    handle.commit();
    assert.equal(liveName(), DIST);
    assert.equal(readFileSync(distRecordPath(dataDir), "utf8"), `${DIST}\n`);
    assert.equal(read(".next/BUILD_ID"), "old", "the old directory stays: the server it served may still be draining");
  });

  it("a failed build removes its own directory, restores the registry and says why; the live build never changed", async () => {
    await assert.rejects(buildWithRollback(options(fails)), (error) => {
      assert.ok(error instanceof BuildFailedError);
      assert.match(error.output, /Type error: nope/);
      assert.equal(error.code, 1);
      return true;
    });
    assert.equal(read(".next/BUILD_ID"), "old");
    assert.equal(read(".next/server/page.js"), "old page");
    assert.equal(read(".next/cache/turbo"), "warm");
    assert.doesNotMatch(read(REGISTRY_FILE), /beta/);
    assert.deepEqual(builds(), [".next"], "no half build and no tsconfig left behind");
    assert.equal(existsSync(distRecordPath(dataDir)), false);
  });

  it("a runner that throws is a failed build too", async () => {
    await assert.rejects(buildWithRollback(options(async () => { throw new Error("spawn failed"); })), /spawn failed/);
    assert.equal(read(".next/BUILD_ID"), "old");
    assert.doesNotMatch(read(REGISTRY_FILE), /beta/);
    assert.deepEqual(builds(), [".next"]);
  });

  it("rollback after a good build (a later step failed) removes the new directory and puts the registry back", async () => {
    const handle = await buildWithRollback(options(succeeds));
    handle.rollback();
    assert.equal(read(".next/BUILD_ID"), "old");
    assert.doesNotMatch(read(REGISTRY_FILE), /beta/);
    assert.deepEqual(builds(), [".next"]);
    assert.equal(liveName(), ".next");
    assert.equal(existsSync(distRecordPath(dataDir)), false);
  });

  it("works when there was no live build, and invents none", async () => {
    rmSync(join(root, ".next"), { recursive: true });
    await assert.rejects(buildWithRollback(options(fails)), BuildFailedError);
    assert.deepEqual(builds(), [], "the half build is removed");
  });

  it("never builds into the directory that is serving", async () => {
    await assert.rejects(buildWithRollback(options(succeeds, { dist: ".next" })), /live/);
    writeLiveDist(dataDir, DIST);
    mkdirSync(join(root, DIST));
    writeFileSync(join(root, DIST, "BUILD_ID"), "serving");
    await assert.rejects(buildWithRollback(options(succeeds)), /live/);
    assert.equal(read(`${DIST}/BUILD_ID`), "serving");
    assert.equal(read(".next/BUILD_ID"), "old");
  });

  it("refuses a name that is not a build directory name before it touches anything", async () => {
    for (const dist of ["../x", "", ".next/x", "other"]) {
      await assert.rejects(buildWithRollback(options(succeeds, { dist })), /not a build directory name/, JSON.stringify(dist));
    }
    assert.doesNotMatch(read(REGISTRY_FILE), /beta/, "the registry was not rewritten");
  });

  it("clears out directories that no longer serve, but not the live one, and not right after a switch", async () => {
    put(".next-stray00001/BUILD_ID", "stray");
    put("tsconfig.next-stray00001.json", "{}");
    await buildWithRollback(options(succeeds));
    assert.equal(existsSync(join(root, ".next-stray00001")), false);
    assert.equal(existsSync(join(root, "tsconfig.next-stray00001.json")), false);
    assert.equal(existsSync(join(root, ".next")), true, "the live build stays");

    // A switch has just been recorded: the server it replaced (.next) may still be draining, so it is not removed yet.
    rmSync(join(root, DIST), { recursive: true });
    put(".next-draining01/BUILD_ID", "serving");
    writeLiveDist(dataDir, ".next-draining01");
    await buildWithRollback({ ...options(quick), dist: ".next-newbuild02" });
    assert.equal(existsSync(join(root, ".next")), true, "the record is fresh");

    const earlier = new Date(Date.now() - 120_000);
    utimesSync(distRecordPath(dataDir), earlier, earlier);
    await buildWithRollback({ ...options(quick), dist: ".next-newbuild04" });
    assert.equal(existsSync(join(root, ".next")), false, "a minute later it is stray");
    assert.equal(existsSync(join(root, ".next-newbuild02")), false, "so is a build nobody committed");
    assert.equal(existsSync(join(root, ".next-draining01")), true, "the live one stays");
  });

  it("will not commit a directory that is not a finished build, so the record can never name one", async () => {
    const handle = await buildWithRollback(options(async (webRoot, _signal, dist) => {
      mkdirSync(join(webRoot, dist!), { recursive: true });
      return { code: 0, output: "built, but wrote no BUILD_ID" };
    }));
    assert.throws(() => handle.commit(), /BUILD_ID/);
    assert.equal(existsSync(distRecordPath(dataDir)), false);
    assert.equal(liveName(), ".next");
  });

  it("passes the stop signal to the build", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    await buildWithRollback(options(async (webRoot, signal, dist) => {
      seen = signal;
      mkdirSync(join(webRoot, dist!), { recursive: true });
      writeFileSync(join(webRoot, dist!, "BUILD_ID"), "n");
      return { code: 0, output: "" };
    }, { signal: controller.signal }));
    assert.equal(seen, controller.signal);
  });
});
