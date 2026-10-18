import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { PlacementRefusedError, placePackage } from "../src/install/place.ts";

let root: string;
let staging: string;
const modulesDir = () => join(root, "modules");
const nodeModules = () => join(root, "node_modules");
const dataDir = () => join(root, "var");

const put = (base: string, path: string, content: string) => {
  mkdirSync(dirname(join(base, path)), { recursive: true });
  writeFileSync(join(base, path), content);
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "modunexo-place-")));
  mkdirSync(modulesDir());
  mkdirSync(nodeModules());
  staging = join(root, "var", "staging", "a".repeat(64));
  put(staging, "package.json", '{"name":"@acme/reports","version":"2.0.0"}');
  put(staging, "manifest.ts", "export default {};\n");
  put(staging, "web/page.tsx", "new\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const options = (extra: Partial<Parameters<typeof placePackage>[0]> = {}) => ({
  stagingDir: staging,
  moduleId: "reports",
  packageName: "@acme/reports",
  version: "2.0.0",
  kind: "install" as const,
  modulesDir: modulesDir(),
  nodeModulesDir: nodeModules(),
  dataDir: dataDir(),
  ...extra,
});

describe("placePackage: install", () => {
  it("copies the staged tree to modules/<id> and links it in node_modules like a workspace does", () => {
    const placement = placePackage(options());
    assert.equal(readFileSync(join(modulesDir(), "reports", "web/page.tsx"), "utf8"), "new\n");
    const link = join(nodeModules(), "@acme", "reports");
    assert.ok(lstatSync(link).isSymbolicLink());
    assert.equal(readlinkSync(link), "../../modules/reports");
    assert.equal(realpathSync(link), join(modulesDir(), "reports"));
    assert.ok(existsSync(staging), "the staged tree is left where it was");
    assert.equal(placement.previousDir, null);
  });

  it("an unscoped package name links directly under node_modules", () => {
    placePackage(options({ packageName: "reports-pkg" }));
    assert.equal(readlinkSync(join(nodeModules(), "reports-pkg")), "../modules/reports");
  });

  it("undo removes the folder, the link and the scope folder it made, leaving the tree as it was", () => {
    const placement = placePackage(options());
    placement.undo();
    assert.deepEqual(readdirSync(modulesDir()), []);
    assert.deepEqual(readdirSync(nodeModules()), []);
  });

  it("refuses an id that already has a folder, and changes nothing", () => {
    put(modulesDir(), "reports/manifest.ts", "old\n");
    assert.throws(() => placePackage(options()), PlacementRefusedError);
    assert.equal(readFileSync(join(modulesDir(), "reports/manifest.ts"), "utf8"), "old\n");
    assert.deepEqual(readdirSync(nodeModules()), []);
  });

  it("refuses a link name that is taken by something else, and leaves no folder behind", () => {
    mkdirSync(join(nodeModules(), "@acme", "reports"), { recursive: true });
    assert.throws(() => placePackage(options()), /node_modules/);
    assert.deepEqual(readdirSync(modulesDir()), []);
    assert.ok(lstatSync(join(nodeModules(), "@acme", "reports")).isDirectory());
  });

  it("refuses ids and names that could point somewhere else", () => {
    for (const moduleId of ["..", "a/b", "A", ""]) assert.throws(() => placePackage(options({ moduleId })), PlacementRefusedError);
    for (const packageName of ["../x", "@a/../b", "/abs", "a b"]) assert.throws(() => placePackage(options({ packageName })), PlacementRefusedError);
    assert.deepEqual(readdirSync(modulesDir()), []);
  });
});

describe("placePackage: upgrade", () => {
  beforeEach(() => {
    put(modulesDir(), "reports/package.json", '{"name":"@acme/reports","version":"1.0.0"}');
    put(modulesDir(), "reports/web/page.tsx", "old\n");
    mkdirSync(join(nodeModules(), "@acme"), { recursive: true });
    symlinkSync("../../modules/reports", join(nodeModules(), "@acme", "reports"));
  });

  it("puts the new version in place and keeps the previous folder under var/previous", () => {
    const placement = placePackage(options({ kind: "upgrade", previousVersion: "1.0.0" }));
    assert.equal(readFileSync(join(modulesDir(), "reports", "web/page.tsx"), "utf8"), "new\n");
    assert.equal(placement.previousDir, join(dataDir(), "previous", "reports-1.0.0"));
    assert.equal(readFileSync(join(placement.previousDir!, "web/page.tsx"), "utf8"), "old\n");
    assert.equal(realpathSync(join(nodeModules(), "@acme", "reports")), join(modulesDir(), "reports"));
  });

  it("undo puts the previous version back exactly", () => {
    const placement = placePackage(options({ kind: "upgrade", previousVersion: "1.0.0" }));
    placement.undo();
    assert.equal(readFileSync(join(modulesDir(), "reports", "web/page.tsx"), "utf8"), "old\n");
    assert.equal(existsSync(join(dataDir(), "previous", "reports-1.0.0")), false);
    assert.equal(realpathSync(join(nodeModules(), "@acme", "reports")), join(modulesDir(), "reports"), "the link of an upgrade was never ours to remove");
  });

  it("refuses an upgrade when the module has no folder or the package name changed", () => {
    rmSync(join(modulesDir(), "reports"), { recursive: true });
    assert.throws(() => placePackage(options({ kind: "upgrade", previousVersion: "1.0.0" })), /no folder/);
    put(modulesDir(), "reports/package.json", '{"name":"@acme/other","version":"1.0.0"}');
    assert.throws(() => placePackage(options({ kind: "upgrade", previousVersion: "1.0.0" })), /name/);
  });
});
