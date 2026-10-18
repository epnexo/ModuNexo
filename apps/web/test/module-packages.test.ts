import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { listModulePackages } from "../src/server/module-packages.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "modunexo-modpkg-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (name: string, json: string | undefined) => {
  mkdirSync(join(dir, name), { recursive: true });
  if (json !== undefined) writeFileSync(join(dir, name, "package.json"), json);
};

describe("listModulePackages", () => {
  it("returns the package names found under the modules directory, sorted", () => {
    write("zeta", JSON.stringify({ name: "@fixture/zeta" }));
    write("alpha", JSON.stringify({ name: "@fixture/alpha" }));
    assert.deepEqual(listModulePackages(dir), { names: ["@fixture/alpha", "@fixture/zeta"], warnings: [] });
  });

  it("returns nothing for a directory that does not exist", () => {
    assert.deepEqual(listModulePackages(join(dir, "missing")), { names: [], warnings: [] });
  });

  it("skips a package.json that cannot be parsed and names the directory in a warning", () => {
    write("good", JSON.stringify({ name: "@fixture/good" }));
    write("half-unpacked", '{ "name": "@fixture/half');
    const result = listModulePackages(dir);
    assert.deepEqual(result.names, ["@fixture/good"]);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0]!, /half-unpacked/);
  });

  it("skips a package.json without a string name, with a warning", () => {
    write("nameless", JSON.stringify({ version: "1.0.0" }));
    write("numeric", JSON.stringify({ name: 42 }));
    const result = listModulePackages(dir);
    assert.deepEqual(result.names, []);
    assert.equal(result.warnings.length, 2);
  });

  it("ignores a directory with no package.json and plain files, without a warning", () => {
    write("no-manifest", undefined);
    writeFileSync(join(dir, ".gitkeep"), "");
    assert.deepEqual(listModulePackages(dir), { names: [], warnings: [] });
  });
});
