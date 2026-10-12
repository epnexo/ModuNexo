import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateManifest } from "../src/index.ts";

const valid = {
  id: "sample-module",
  version: "0.1.0",
  name: "Sample Module",
  platform: "^0.1.0",
  dependsOn: { base: "^1.0.0" },
  schema: "ai_usage",
  migrationsDir: "migrations",
  nav: [{ label: "Sample", href: "/sample", icon: "chart" }],
};

describe("validateManifest: base rules", () => {
  it("accepts a valid manifest and returns it typed", () => {
    const manifest = validateManifest(valid);
    assert.equal(manifest.id, "sample-module");
    assert.deepEqual(manifest.dependsOn, { base: "^1.0.0" });
  });

  it("accepts a nav entry without an icon", () => {
    const manifest = validateManifest({ ...valid, nav: [{ label: "Home", href: "/" }] });
    assert.equal(manifest.nav[0]?.icon, undefined);
  });

  it("rejects non-object input", () => {
    assert.throws(() => validateManifest(null), /manifest must be an object/);
    assert.throws(() => validateManifest("x"), /manifest must be an object/);
    assert.throws(() => validateManifest([]), /manifest must be an object/);
  });

  it("rejects ids that are not kebab-case", () => {
    for (const id of ["AiUsage", "ai_usage", "-ai", "ai-", "1ai", ""]) {
      assert.throws(() => validateManifest({ ...valid, id }), /id must be kebab-case/, id);
    }
  });

  it("rejects versions that are not semver", () => {
    for (const version of ["1.0", "v1.0.0", "", 1]) {
      assert.throws(() => validateManifest({ ...valid, version }), /version must be semver/, String(version));
    }
  });

  it("accepts a prerelease version and rejects build metadata", () => {
    assert.equal(validateManifest({ ...valid, version: "1.0.0-rc.1" }).version, "1.0.0-rc.1");
    assert.throws(() => validateManifest({ ...valid, version: "1.0.0+build.5" }), /version must be semver MAJOR\.MINOR\.PATCH.*no build metadata/);
    assert.throws(() => validateManifest({ ...valid, version: "1.0.0-rc.1+build.5" }), /no build metadata/);
  });

  it("rejects an empty name", () => {
    assert.throws(() => validateManifest({ ...valid, name: " " }), /name must be a non-empty string/);
  });

  it("rejects invalid schema names", () => {
    for (const schema of ["AI", "sample-module", "1x", "pg_catalog", "public", "core", "a".repeat(64)]) {
      assert.throws(() => validateManifest({ ...valid, schema }), /schema/, schema);
    }
  });

  it("admits the core schema only when asked, and never another reserved schema", () => {
    const core = { ...valid, id: "core", schema: "core" };
    assert.throws(() => validateManifest(core), /schema must be/);
    assert.equal(validateManifest(core, { allowCoreSchema: true }).schema, "core");
    for (const schema of ["public", "information_schema", "pg_catalog"]) {
      assert.throws(() => validateManifest({ ...valid, schema }, { allowCoreSchema: true }), /schema must be/, schema);
    }
  });

  it("admits the core schema only for the manifest whose id is also core", () => {
    assert.throws(() => validateManifest({ ...valid, schema: "core" }, { allowCoreSchema: true }), /schema must be/);
  });

  it("rejects an empty migrationsDir", () => {
    assert.throws(() => validateManifest({ ...valid, migrationsDir: "" }), /migrationsDir/);
  });

  it("rejects invalid nav entries", () => {
    assert.throws(() => validateManifest({ ...valid, nav: [{ label: "", href: "/x" }] }), /nav\[0\]\.label/);
    assert.throws(() => validateManifest({ ...valid, nav: [{ label: "X", href: "x" }] }), /nav\[0\]\.href/);
    assert.throws(() => validateManifest({ ...valid, nav: [{ label: "X", href: "/x", icon: 3 }] }), /nav\[0\]\.icon/);
  });

  it("rejects unknown fields so typos do not pass silently", () => {
    assert.throws(() => validateManifest({ ...valid, dependsOnn: {} }), /unknown field "dependsOnn"/);
    assert.throws(
      () => validateManifest({ ...valid, nav: [{ label: "X", href: "/x", colour: "red" }] }),
      /nav\[0\] has unknown field "colour"/,
    );
  });

  it("reports every problem in one error", () => {
    assert.throws(
      () => validateManifest({ ...valid, id: "Bad", version: "x" }),
      (error: Error) => /id must be kebab-case/.test(error.message) && /version must be semver/.test(error.message),
    );
  });
});

describe("validateManifest: platform and dependsOn", () => {
  it("requires platform to be a valid semver range", () => {
    for (const platform of ["", "not a range", 1, undefined]) {
      assert.throws(() => validateManifest({ ...valid, platform }), /platform must be a valid semver range/, String(platform));
    }
    assert.doesNotThrow(() => validateManifest({ ...valid, platform: ">=0.1.0 <1.0.0" }));
  });

  it("requires dependsOn to be a map of module id to semver range", () => {
    assert.throws(() => validateManifest({ ...valid, dependsOn: ["core"] }), /dependsOn must be an object/);
    assert.throws(() => validateManifest({ ...valid, dependsOn: "core" }), /dependsOn must be an object/);
    assert.throws(() => validateManifest({ ...valid, dependsOn: { Bad_Id: "^1.0.0" } }), /dependsOn key "Bad_Id" must be a kebab-case module id/);
    assert.throws(() => validateManifest({ ...valid, dependsOn: { base: "nope" } }), /dependsOn\.base must be a valid semver range/);
    assert.throws(() => validateManifest({ ...valid, dependsOn: { base: 1 } }), /dependsOn\.base must be a valid semver range/);
    assert.doesNotThrow(() => validateManifest({ ...valid, dependsOn: {} }));
  });

  it("rejects a module that depends on itself", () => {
    assert.throws(() => validateManifest({ ...valid, dependsOn: { "sample-module": "^0.1.0" } }), /cannot depend on itself/);
  });
});
