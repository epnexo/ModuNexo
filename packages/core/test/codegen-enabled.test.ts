import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { SDK_VERSION, type ModuleManifest } from "@modunexo/sdk";
import { readPackageName, registrationModulesFor } from "../src/codegen/enabled.ts";
import { RegistrationError } from "../src/codegen/render.ts";
import { Registry } from "../src/registry.ts";
import type { ModuleStatus } from "../src/lifecycle/status.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "modunexo-enabled-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const manifest = (id: string): ModuleManifest => ({ id, version: "1.0.0", name: id, platform: `^${SDK_VERSION}`, dependsOn: {}, schema: id, migrationsDir: "migrations", nav: [] });
const status = (id: string, extra: Partial<ModuleStatus> = {}): ModuleStatus => ({
  id, status: "enabled", packageVersion: "1.0.0", installedVersion: "1.0.0", upgradePending: false, orphaned: false, dataRetained: false, invalidInstalledVersion: false, ...extra,
});
const addPackage = (id: string, name: string | null = `@fixture/${id}`) => {
  mkdirSync(join(dir, id), { recursive: true });
  writeFileSync(join(dir, id, "package.json"), JSON.stringify(name === null ? {} : { name }));
};
const registryOf = (...ids: string[]) => {
  const registry = new Registry();
  registry.registerCore();
  for (const id of ids) registry.register(manifest(id));
  return registry;
};

describe("readPackageName", () => {
  it("reads the name from the module folder's package.json", () => {
    addPackage("alpha", "@fixture/alpha");
    assert.equal(readPackageName(dir, "alpha"), "@fixture/alpha");
  });

  it("explains a missing package.json and a missing name", () => {
    mkdirSync(join(dir, "alpha"));
    assert.throws(() => readPackageName(dir, "alpha"), /module "alpha" has no package\.json/);
    addPackage("alpha", null);
    assert.throws(() => readPackageName(dir, "alpha"), /package\.json of module "alpha" has no "name"/);
    writeFileSync(join(dir, "alpha", "package.json"), "{ nope");
    assert.throws(() => readPackageName(dir, "alpha"), /package\.json of module "alpha" is not valid JSON/);
  });
});

describe("registrationModulesFor", () => {
  it("takes only enabled modules, with the manifest from the registry and the package name from disk", () => {
    addPackage("alpha");
    addPackage("beta");
    addPackage("gamma");
    const { modules, warnings } = registrationModulesFor(
      [status("alpha"), status("beta", { status: "disabled" }), status("gamma", { status: "available", installedVersion: undefined })],
      registryOf("alpha", "beta", "gamma"),
      dir,
    );
    assert.deepEqual(modules.map((m) => [m.manifest.id, m.packageName]), [["alpha", "@fixture/alpha"]]);
    assert.deepEqual(warnings, []);
  });

  it("warns about a pending upgrade and skips an enabled row whose package is gone", () => {
    addPackage("alpha");
    const { modules, warnings } = registrationModulesFor(
      [status("alpha", { upgradePending: true, packageVersion: "1.1.0" }), status("lost", { orphaned: true })],
      registryOf("alpha"),
      dir,
    );
    assert.deepEqual(modules.map((m) => m.manifest.id), ["alpha"]);
    assert.equal(warnings.length, 2);
    assert.match(warnings[0]!, /module "alpha" has an upgrade pending.*1\.1\.0.*1\.0\.0/);
    assert.match(warnings[1]!, /module "lost" is enabled but its package is not on disk; not registered/);
  });

  it("reports every module whose package.json cannot be used, as one registration error", () => {
    addPackage("alpha", null);
    const error = (() => {
      try {
        registrationModulesFor([status("alpha"), status("beta")], registryOf("alpha", "beta"), dir);
      } catch (e) {
        return e;
      }
    })();
    assert.ok(error instanceof RegistrationError);
    assert.equal(error.problems.length, 2);
  });
});
