import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { SDK_VERSION, defineModule } from "../src/index.ts";

describe("SDK_VERSION", () => {
  it("equals the version in the package manifest", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    assert.equal(SDK_VERSION, pkg.version);
  });
});

describe("defineModule", () => {
  it("returns the manifest it receives", () => {
    const manifest = {
      id: "demo",
      version: "1.0.0",
      name: "Demo",
      platform: "^0.1.0",
      dependsOn: {},
      schema: "demo",
      migrationsDir: "migrations",
      nav: [],
    };
    assert.equal(defineModule(manifest), manifest);
  });
});
