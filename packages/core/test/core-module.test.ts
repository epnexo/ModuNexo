import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { SDK_VERSION, validateManifest } from "@modunexo/sdk";
import { CORE_MODULE_ID, CORE_VERSION, coreManifest } from "../src/index.ts";

describe("coreManifest", () => {
  it("describes the core as a module that owns the core schema and has no navigation", () => {
    assert.equal(coreManifest.id, CORE_MODULE_ID);
    assert.equal(coreManifest.schema, "core");
    assert.deepEqual(coreManifest.nav, []);
    assert.deepEqual(coreManifest.dependsOn, {});
  });

  it("carries the version of the core package", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    assert.equal(CORE_VERSION, pkg.version);
    assert.equal(coreManifest.version, pkg.version);
  });

  it("targets the SDK it was built with", () => {
    assert.equal(coreManifest.platform, `^${SDK_VERSION}`);
  });

  it("is only valid through the narrow core-schema admission", () => {
    assert.throws(() => validateManifest(coreManifest), /schema must be/);
    assert.equal(validateManifest(coreManifest, { allowCoreSchema: true }).id, "core");
  });
});
