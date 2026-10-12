import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SDK_VERSION, type ModuleManifest } from "@epnexo/sdk";
import { Registry } from "../src/registry.ts";
import { deriveStatus } from "../src/lifecycle/status.ts";
import {
  type InstalledModule,
  type LifecycleAction,
  type LifecycleState,
  type Refusal,
  type TransitionPlan,
  type TransitionRequest,
  planTransition,
} from "../src/lifecycle/transitions.ts";

function manifest(id: string, options: { dependsOn?: string[]; version?: string; platform?: string } = {}): ModuleManifest {
  return {
    id,
    version: options.version ?? "1.0.0",
    name: id,
    platform: options.platform ?? `^${SDK_VERSION}`,
    dependsOn: Object.fromEntries((options.dependsOn ?? []).map((dep) => [dep, "*"])),
    schema: id.replaceAll("-", "_"),
    migrationsDir: "migrations",
    nav: [],
  };
}

function registryOf(...manifests: ModuleManifest[]): Registry {
  const registry = new Registry({ allowUnsupportedPlatform: true });
  registry.registerCore();
  for (const m of manifests) registry.register(m);
  return registry;
}

/** Installed modules by id, each at the given state and version 1.0.0 unless a version is given as `id@version`. */
function statesOf(entries: Record<string, LifecycleState>, versions: Record<string, string> = {}): Map<string, InstalledModule> {
  return new Map(Object.entries(entries).map(([id, state]) => [id, { id, state, installedVersion: versions[id] ?? "1.0.0" }]));
}

const plan = (request: TransitionRequest, states: Map<string, InstalledModule>, registry: Registry): TransitionPlan => {
  const result = planTransition(request, states, registry);
  assert.ok(result.ok, result.ok ? "" : `refused: ${result.refusal.message}`);
  return result.plan;
};

const refusal = (request: TransitionRequest, states: Map<string, InstalledModule>, registry: Registry): Refusal => {
  const result = planTransition(request, states, registry);
  assert.ok(!result.ok, "expected a refusal");
  return result.refusal;
};

describe("planTransition: install", () => {
  it("takes an available module to enabled at the package version", () => {
    const result = plan({ action: "install", moduleId: "a" }, statesOf({}), registryOf(manifest("a", { version: "1.2.0" })));
    assert.deepEqual(result, { action: "install", moduleId: "a", from: "available", to: "enabled", version: "1.2.0", disableFirst: false, noop: false });
  });

  it("refuses a module that is already installed, whatever its state", () => {
    for (const state of ["enabled", "disabled"] as const) {
      const result = refusal({ action: "install", moduleId: "a" }, statesOf({ a: state }), registryOf(manifest("a")));
      assert.equal(result.code, "already_installed");
      assert.match(result.message, /"a" is already installed/);
    }
  });

  it("refuses an unknown module", () => {
    const result = refusal({ action: "install", moduleId: "ghost" }, statesOf({}), registryOf(manifest("a")));
    assert.equal(result.code, "unknown_module");
    assert.match(result.message, /"ghost"/);
  });

  it("requires every dependency to be enabled and names the ones that are not", () => {
    const registry = registryOf(manifest("a"), manifest("b"), manifest("c"), manifest("app", { dependsOn: ["a", "b", "c"] }));
    const result = refusal({ action: "install", moduleId: "app" }, statesOf({ a: "enabled", b: "disabled" }), registry);
    assert.equal(result.code, "dependency_not_enabled");
    assert.deepEqual(result.related, ["b", "c"]);
    assert.match(result.message, /"app" needs "b", "c" to be enabled first/);
  });

  it("separates a dependency whose package is missing from one that is merely not enabled", () => {
    // A registry only holds packages that are on disk, so a dependency it does not know has no package.
    const registry = registryOf(manifest("app", { dependsOn: ["gone"] }));
    const result = refusal({ action: "install", moduleId: "app" }, statesOf({}), registry);
    assert.equal(result.code, "dependency_missing");
    assert.deepEqual(result.related, ["gone"]);
  });

  it("installs once all dependencies are enabled", () => {
    const registry = registryOf(manifest("a"), manifest("app", { dependsOn: ["a"] }));
    assert.equal(plan({ action: "install", moduleId: "app" }, statesOf({ a: "enabled" }), registry).to, "enabled");
  });

  it("refuses a module whose platform range the SDK does not satisfy", () => {
    const result = refusal({ action: "install", moduleId: "a" }, statesOf({}), registryOf(manifest("a", { platform: "^9.0.0" })));
    assert.equal(result.code, "platform_unsupported");
    assert.match(result.message, /platform "\^9\.0\.0".*SDK version/);
  });
});

describe("planTransition: enable", () => {
  it("takes a disabled module to enabled, keeping the installed version", () => {
    const result = plan({ action: "enable", moduleId: "a" }, statesOf({ a: "disabled" }, { a: "0.9.0" }), registryOf(manifest("a", { version: "1.0.0" })));
    assert.deepEqual(result, { action: "enable", moduleId: "a", from: "disabled", to: "enabled", version: "0.9.0", disableFirst: false, noop: false });
  });

  it("refuses an enabled module and one that is not installed", () => {
    const registry = registryOf(manifest("a"));
    assert.equal(refusal({ action: "enable", moduleId: "a" }, statesOf({ a: "enabled" }), registry).code, "already_enabled");
    assert.equal(refusal({ action: "enable", moduleId: "a" }, statesOf({}), registry).code, "not_installed");
  });

  it("requires dependencies to be enabled", () => {
    const registry = registryOf(manifest("a"), manifest("app", { dependsOn: ["a"] }));
    const result = refusal({ action: "enable", moduleId: "app" }, statesOf({ a: "disabled", app: "disabled" }), registry);
    assert.equal(result.code, "dependency_not_enabled");
    assert.deepEqual(result.related, ["a"]);
  });
});

describe("planTransition: disable", () => {
  it("takes an enabled module to disabled", () => {
    const result = plan({ action: "disable", moduleId: "a" }, statesOf({ a: "enabled" }), registryOf(manifest("a")));
    assert.deepEqual(result, { action: "disable", moduleId: "a", from: "enabled", to: "disabled", version: "1.0.0", disableFirst: false, noop: false });
  });

  it("refuses a disabled module and one that is not installed", () => {
    const registry = registryOf(manifest("a"));
    assert.equal(refusal({ action: "disable", moduleId: "a" }, statesOf({ a: "disabled" }), registry).code, "already_disabled");
    assert.equal(refusal({ action: "disable", moduleId: "a" }, statesOf({}), registry).code, "not_installed");
  });

  it("is refused while an enabled module depends on it, naming the dependents", () => {
    const registry = registryOf(manifest("a"), manifest("b", { dependsOn: ["a"] }), manifest("c", { dependsOn: ["a"] }));
    const result = refusal({ action: "disable", moduleId: "a" }, statesOf({ a: "enabled", b: "enabled", c: "enabled" }), registry);
    assert.equal(result.code, "has_enabled_dependents");
    assert.deepEqual(result.related, ["b", "c"]);
    assert.match(result.message, /enabled modules depend on "a": "b", "c"/);
  });

  it("counts a transitive dependent even when the module in between is disabled", () => {
    const registry = registryOf(manifest("a"), manifest("b", { dependsOn: ["a"] }), manifest("c", { dependsOn: ["b"] }));
    const result = refusal({ action: "disable", moduleId: "a" }, statesOf({ a: "enabled", b: "disabled", c: "enabled" }), registry);
    assert.equal(result.code, "has_enabled_dependents");
    assert.deepEqual(result.related, ["c"]);
  });

  it("is not blocked by dependents that are disabled or not installed", () => {
    const registry = registryOf(manifest("a"), manifest("b", { dependsOn: ["a"] }), manifest("c", { dependsOn: ["a"] }));
    assert.equal(plan({ action: "disable", moduleId: "a" }, statesOf({ a: "enabled", b: "disabled" }), registry).to, "disabled");
  });
});

describe("planTransition: upgrade", () => {
  const request: TransitionRequest = { action: "upgrade", moduleId: "a" };

  it("moves an installed module to the newer package version, keeping its state", () => {
    for (const state of ["enabled", "disabled"] as const) {
      const result = plan(request, statesOf({ a: state }), registryOf(manifest("a", { version: "1.1.0" })));
      assert.deepEqual(result, { action: "upgrade", moduleId: "a", from: state, to: state, version: "1.1.0", previousVersion: "1.0.0", disableFirst: false, noop: false });
    }
  });

  it("treats an equal version as nothing to do", () => {
    const result = plan(request, statesOf({ a: "enabled" }), registryOf(manifest("a", { version: "1.0.0" })));
    assert.equal(result.noop, true);
    assert.equal(result.version, "1.0.0");
  });

  it("refuses a lower package version: there is no downgrade", () => {
    const result = refusal(request, statesOf({ a: "enabled" }, { a: "2.0.0" }), registryOf(manifest("a", { version: "1.9.0" })));
    assert.equal(result.code, "downgrade");
    assert.match(result.message, /package version 1\.9\.0 is lower than the installed 2\.0\.0/);
  });

  it("orders versions as semver does, prereleases included", () => {
    assert.equal(plan(request, statesOf({ a: "enabled" }, { a: "1.1.0-rc.1" }), registryOf(manifest("a", { version: "1.1.0" }))).noop, false);
    assert.equal(refusal(request, statesOf({ a: "enabled" }, { a: "1.1.0" }), registryOf(manifest("a", { version: "1.1.0-rc.1" }))).code, "downgrade");
    assert.equal(plan(request, statesOf({ a: "enabled" }, { a: "1.9.0" }), registryOf(manifest("a", { version: "1.10.0" }))).noop, false);
  });

  it("refuses a module that is not installed, and a package the platform does not support", () => {
    assert.equal(refusal(request, statesOf({}), registryOf(manifest("a", { version: "1.1.0" }))).code, "not_installed");
    const unsupported = registryOf(manifest("a", { version: "1.1.0", platform: "^9.0.0" }));
    assert.equal(refusal(request, statesOf({ a: "enabled" }), unsupported).code, "platform_unsupported");
  });
});

describe("planTransition: uninstall", () => {
  it("takes a disabled module to available with the chosen mode", () => {
    const result = plan({ action: "uninstall", moduleId: "a", mode: "keep" }, statesOf({ a: "disabled" }), registryOf(manifest("a")));
    assert.deepEqual(result, { action: "uninstall", moduleId: "a", from: "disabled", to: "available", version: "1.0.0", mode: "keep", disableFirst: false, noop: false });
  });

  it("asks for the module to be disabled first when it is enabled", () => {
    const result = plan({ action: "uninstall", moduleId: "a", mode: "purge" }, statesOf({ a: "enabled" }), registryOf(manifest("a")));
    assert.equal(result.from, "enabled");
    assert.equal(result.disableFirst, true);
    assert.equal(result.mode, "purge");
  });

  it("refuses without a mode: there is no default", () => {
    const registry = registryOf(manifest("a"));
    for (const mode of [undefined, "drop" as never, "" as never]) {
      const result = refusal({ action: "uninstall", moduleId: "a", mode }, statesOf({ a: "disabled" }), registry);
      assert.equal(result.code, "mode_required");
      assert.match(result.message, /keep.*purge/);
    }
  });

  it("is refused while any installed module depends on it, enabled or disabled, directly or not", () => {
    const registry = registryOf(manifest("a"), manifest("b", { dependsOn: ["a"] }), manifest("c", { dependsOn: ["b"] }), manifest("d", { dependsOn: ["a"] }));
    const result = refusal({ action: "uninstall", moduleId: "a", mode: "keep" }, statesOf({ a: "disabled", b: "disabled", c: "enabled" }), registry);
    assert.equal(result.code, "has_installed_dependents");
    assert.deepEqual(result.related, ["b", "c"]);
    assert.match(result.message, /installed modules depend on "a": "b", "c"/);
  });

  it("refuses a module that is not installed", () => {
    assert.equal(refusal({ action: "uninstall", moduleId: "a", mode: "keep" }, statesOf({}), registryOf(manifest("a"))).code, "not_installed");
  });
});

describe("planTransition: the core and orphans", () => {
  it("never lets the core be installed, enabled, disabled, upgraded or uninstalled", () => {
    for (const action of ["install", "enable", "disable", "upgrade", "uninstall"] as LifecycleAction[]) {
      const result = refusal({ action, moduleId: "core", mode: "purge" }, statesOf({}), registryOf());
      assert.equal(result.code, "core_protected", action);
      assert.match(result.message, /core/);
    }
  });

  it("refuses every action on a module recorded as installed whose package is gone", () => {
    const states = statesOf({ lost: "enabled" });
    for (const action of ["enable", "disable", "upgrade", "uninstall"] as LifecycleAction[]) {
      const result = refusal({ action, moduleId: "lost", mode: "keep" }, states, registryOf());
      assert.equal(result.code, "unknown_module", action);
    }
  });
});

describe("deriveStatus", () => {
  const m = (version: string) => manifest("a", { version });
  const row = (state: LifecycleState, installedVersion = "1.0.0"): InstalledModule => ({ id: "a", state, installedVersion });

  it("reports a package with no row as available", () => {
    assert.deepEqual(deriveStatus({ id: "a", manifest: m("1.0.0"), schemaExists: false }), {
      id: "a",
      status: "available",
      packageVersion: "1.0.0",
      upgradePending: false,
      orphaned: false,
      dataRetained: false,
    });
  });

  it("reports the stored state and both versions for an installed module", () => {
    assert.deepEqual(deriveStatus({ id: "a", manifest: m("1.0.0"), installed: row("disabled"), schemaExists: true }), {
      id: "a",
      status: "disabled",
      packageVersion: "1.0.0",
      installedVersion: "1.0.0",
      upgradePending: false,
      orphaned: false,
      dataRetained: false,
    });
  });

  it("flags an upgrade only when the package is newer than the installed version", () => {
    assert.equal(deriveStatus({ id: "a", manifest: m("1.1.0"), installed: row("enabled"), schemaExists: true }).upgradePending, true);
    assert.equal(deriveStatus({ id: "a", manifest: m("1.0.0"), installed: row("enabled"), schemaExists: true }).upgradePending, false);
    assert.equal(deriveStatus({ id: "a", manifest: m("0.9.0"), installed: row("enabled"), schemaExists: true }).upgradePending, false);
    assert.equal(deriveStatus({ id: "a", manifest: m("1.0.0"), installed: row("enabled", "1.0.0-rc.1"), schemaExists: true }).upgradePending, true);
  });

  it("flags a row with no package as orphaned and keeps its stored state", () => {
    const status = deriveStatus({ id: "a", installed: row("enabled"), schemaExists: true });
    assert.equal(status.orphaned, true);
    assert.equal(status.status, "enabled");
    assert.equal(status.packageVersion, undefined);
    assert.equal(status.upgradePending, false);
  });

  it("flags retained data only for an available module whose schema is still there", () => {
    assert.equal(deriveStatus({ id: "a", manifest: m("1.0.0"), schemaExists: true }).dataRetained, true);
    assert.equal(deriveStatus({ id: "a", manifest: m("1.0.0"), installed: row("enabled"), schemaExists: true }).dataRetained, false);
    assert.equal(deriveStatus({ id: "a", manifest: m("1.0.0"), schemaExists: false }).dataRetained, false);
  });
});
