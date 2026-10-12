import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SDK_VERSION, type ModuleManifest } from "@epnexo/sdk";
import { Registry, compareIds } from "../src/index.ts";

interface Options {
  dependsOn?: Record<string, string>;
  schema?: string;
  version?: string;
  platform?: string;
}

function manifest(id: string, options: Options = {}): ModuleManifest {
  return {
    id,
    version: options.version ?? "1.0.0",
    name: id,
    platform: options.platform ?? `^${SDK_VERSION}`,
    dependsOn: options.dependsOn ?? {},
    schema: options.schema ?? id.replaceAll("-", "_"),
    migrationsDir: "migrations",
    nav: [],
  };
}

/** Shorthand for a module depending on `deps`, each with any version. */
const needs = (...deps: string[]): Options => ({ dependsOn: Object.fromEntries(deps.map((dep) => [dep, "*"])) });

const ids = (modules: ModuleManifest[]) => modules.map((m) => m.id);
const order = (registry: Registry) => ids(registry.resolveOrder());

describe("Registry: registration", () => {
  it("validates manifests on register", () => {
    const registry = new Registry();
    assert.throws(() => registry.register({ ...manifest("a"), id: "Bad" }), /id must be kebab-case/);
  });

  it("returns the registered manifest through get", () => {
    const registry = new Registry();
    const registered = registry.register(manifest("a"));
    assert.equal(registry.get("a"), registered);
    assert.equal(registry.get("missing"), undefined);
  });

  it("rejects duplicate ids", () => {
    const registry = new Registry();
    registry.register(manifest("a"));
    assert.throws(() => registry.register(manifest("a", { schema: "other" })), /module "a" is already registered/);
  });

  it("rejects two modules that own the same schema", () => {
    const registry = new Registry();
    registry.register(manifest("a", { schema: "shared" }));
    assert.throws(() => registry.register(manifest("b", { schema: "shared" })), /schema "shared" is already owned by module "a"/);
  });

  it("rejects a module whose platform range the SDK does not satisfy, naming module, range and SDK version", () => {
    const registry = new Registry();
    assert.throws(
      () => registry.register(manifest("a", { platform: "^9.0.0" })),
      new RegExp(`module "a" requires platform "\\^9\\.0\\.0" but the SDK version is ${SDK_VERSION.replaceAll(".", "\\.")}`),
    );
    assert.equal(registry.get("a"), undefined);
  });

  it("does not let a business module use the reserved core id or schema", () => {
    const registry = new Registry();
    assert.throws(() => registry.register(manifest("core", { schema: "other" })), /module id "core" is reserved/);
    assert.throws(() => registry.register(manifest("a", { schema: "core" })), /schema must be/);
  });
});

describe("Registry: the core module", () => {
  it("admits the core manifest through registerCore and exposes it", () => {
    const registry = new Registry();
    const core = registry.registerCore();
    assert.equal(core.id, "core");
    assert.equal(registry.get("core"), core);
  });

  it("registers the core only once", () => {
    const registry = new Registry();
    registry.registerCore();
    assert.throws(() => registry.registerCore(), /module "core" is already registered/);
  });

  it("orders the core first and makes every other module depend on it implicitly", () => {
    const registry = new Registry();
    registry.register(manifest("aaa"));
    registry.registerCore();
    registry.register(manifest("zzz", needs("aaa")));
    assert.deepEqual(order(registry), ["core", "aaa", "zzz"]);
    assert.deepEqual(ids(registry.dependentsOf("core")), ["aaa", "zzz"]);
  });
});

describe("Registry: resolveOrder", () => {
  it("orders dependencies before dependents", () => {
    const registry = new Registry();
    registry.register(manifest("c", needs("b")));
    registry.register(manifest("b", needs("a")));
    registry.register(manifest("a"));
    assert.deepEqual(order(registry), ["a", "b", "c"]);
  });

  it("is deterministic: independent modules sort by id regardless of registration order", () => {
    const first = new Registry();
    for (const id of ["z", "m", "a"]) first.register(manifest(id));
    const second = new Registry();
    for (const id of ["a", "z", "m"]) second.register(manifest(id));
    assert.deepEqual(order(first), ["a", "m", "z"]);
    assert.deepEqual(order(second), ["a", "m", "z"]);
  });

  it("returns an empty order for an empty registry", () => {
    assert.deepEqual(order(new Registry()), []);
  });

  it("rejects unknown dependencies and names the module and the dependency", () => {
    const registry = new Registry();
    registry.register(manifest("a", needs("ghost")));
    assert.throws(() => registry.resolveOrder(), /module "a" depends on unknown module "ghost"/);
  });

  it("detects a cycle and names it", () => {
    const registry = new Registry();
    registry.register(manifest("a", needs("b")));
    registry.register(manifest("b", needs("c")));
    registry.register(manifest("c", needs("a")));
    assert.throws(() => registry.resolveOrder(), /dependency cycle: a -> b -> c -> a/);
  });

  it("detects a cycle that is not reachable from the first module", () => {
    const registry = new Registry();
    registry.register(manifest("a"));
    registry.register(manifest("x", needs("y")));
    registry.register(manifest("y", needs("x")));
    assert.throws(() => registry.resolveOrder(), /dependency cycle: x -> y -> x/);
  });

  it("rejects a dependency whose version does not satisfy the range, naming both versions", () => {
    const registry = new Registry();
    registry.register(manifest("base", { version: "1.4.0" }));
    registry.register(manifest("app", { dependsOn: { base: "^2.0.0" } }));
    assert.throws(() => registry.resolveOrder(), /module "app" requires "base" \^2\.0\.0 but version 1\.4\.0 is registered/);
  });

  it("accepts a dependency whose version satisfies the range", () => {
    const registry = new Registry();
    registry.register(manifest("base", { version: "1.4.0" }));
    registry.register(manifest("app", { dependsOn: { base: "^1.2.0" } }));
    assert.deepEqual(order(registry), ["base", "app"]);
  });
});

describe("Registry: problems", () => {
  it("is empty for a sound graph", () => {
    const registry = new Registry();
    registry.register(manifest("a"));
    registry.register(manifest("b", needs("a")));
    assert.deepEqual(registry.problems(), []);
  });

  it("reports every problem without throwing", () => {
    const registry = new Registry();
    registry.register(manifest("a", needs("ghost")));
    registry.register(manifest("base", { version: "1.0.0" }));
    registry.register(manifest("app", { dependsOn: { base: "^2.0.0" } }));
    registry.register(manifest("x", needs("y")));
    registry.register(manifest("y", needs("x")));
    const problems = registry.problems();
    assert.equal(problems.length, 3);
    assert.match(problems.join("\n"), /module "a" depends on unknown module "ghost"/);
    assert.match(problems.join("\n"), /module "app" requires "base" \^2\.0\.0 but version 1\.0\.0 is registered/);
    assert.match(problems.join("\n"), /dependency cycle: x -> y -> x/);
  });

  it("makes resolveOrder throw all of them", () => {
    const registry = new Registry();
    registry.register(manifest("a", needs("ghost")));
    registry.register(manifest("x", needs("y")));
    registry.register(manifest("y", needs("x")));
    assert.throws(() => registry.resolveOrder(), /unknown module "ghost"[^]*dependency cycle: x -> y -> x/);
  });
});

describe("Registry: dependents", () => {
  function chain(): Registry {
    const registry = new Registry();
    registry.register(manifest("a"));
    registry.register(manifest("b", needs("a")));
    registry.register(manifest("c", needs("b")));
    registry.register(manifest("d", needs("a")));
    registry.register(manifest("e"));
    return registry;
  }

  it("lists the modules that depend directly on a module, sorted by id", () => {
    assert.deepEqual(ids(chain().dependentsOf("a")), ["b", "d"]);
    assert.deepEqual(ids(chain().dependentsOf("b")), ["c"]);
    assert.deepEqual(ids(chain().dependentsOf("c")), []);
  });

  it("lists transitive dependents without repeating a module", () => {
    const registry = chain();
    registry.register(manifest("f", needs("c", "d")));
    assert.deepEqual(ids(registry.transitiveDependentsOf("a")), ["b", "c", "d", "f"]);
    assert.deepEqual(ids(registry.transitiveDependentsOf("e")), []);
  });

  it("returns nothing for an unknown module", () => {
    assert.deepEqual(chain().dependentsOf("ghost"), []);
    assert.deepEqual(chain().transitiveDependentsOf("ghost"), []);
  });

  it("terminates on a cyclic graph", () => {
    const registry = new Registry();
    registry.register(manifest("x", needs("y")));
    registry.register(manifest("y", needs("x")));
    assert.deepEqual(ids(registry.transitiveDependentsOf("x")), ["y"]);
  });
});

describe("Registry: id ordering", () => {
  // Hyphens and digits are where a locale-aware comparison and a plain code-unit comparison can disagree.
  const tricky = ["a-b", "a1", "a10", "a2", "ab", "a-1", "b"];

  it("compares ids by code unit, independent of the host locale", () => {
    assert.deepEqual([...tricky].sort(compareIds), ["a-1", "a-b", "a1", "a10", "a2", "ab", "b"]);
    assert.equal(compareIds("a", "a"), 0);
    assert.ok(compareIds("a", "b") < 0 && compareIds("b", "a") > 0);
  });

  it("lists dependents in the same order resolveOrder breaks ties", () => {
    const registry = new Registry();
    registry.register(manifest("base"));
    for (const id of tricky) registry.register(manifest(id, needs("base")));

    const expected = order(registry).filter((id) => id !== "base");
    assert.deepEqual(ids(registry.dependentsOf("base")), expected);
    assert.deepEqual(ids(registry.transitiveDependentsOf("base")), expected);
    assert.deepEqual(expected, [...tricky].sort(compareIds));
  });
});

describe("Registry: prerelease dependencies", () => {
  // Semver's default rule is kept on purpose: a prerelease only satisfies a range that names its own
  // prerelease line, so a release candidate never silently stands in for a stable dependency.
  it("does not satisfy an ordinary range and is reported as a version mismatch", () => {
    const registry = new Registry();
    registry.register(manifest("base", { version: "1.0.0-rc.1" }));
    registry.register(manifest("app", { dependsOn: { base: "^1.0.0" } }));
    assert.throws(() => registry.resolveOrder(), /module "app" requires "base" \^1\.0\.0 but version 1\.0\.0-rc\.1 is registered/);
  });

  it("satisfies a range that names the prerelease line", () => {
    const registry = new Registry();
    registry.register(manifest("base", { version: "1.0.0-rc.1" }));
    registry.register(manifest("app", { dependsOn: { base: "^1.0.0-rc.0" } }));
    assert.deepEqual(order(registry), ["base", "app"]);
  });
});

describe("Registry: admitted manifests are immutable", () => {
  it("is unaffected by changes to the original object after registration", () => {
    const original = manifest("a", { dependsOn: { b: "*" } });
    original.nav = [{ label: "A", href: "/a" }];
    const registry = new Registry();
    registry.register(manifest("b"));
    registry.register(original);

    original.schema = "hijacked";
    original.version = "9.9.9";
    original.dependsOn.b = "^9.0.0";
    original.nav[0]!.label = "changed";

    const stored = registry.get("a")!;
    assert.equal(stored.schema, "a");
    assert.equal(stored.version, "1.0.0");
    assert.equal(stored.dependsOn.b, "*");
    assert.equal(stored.nav[0]!.label, "A");
    assert.deepEqual(registry.problems(), []);
    assert.throws(() => registry.register(manifest("c", { schema: "a" })), /schema "a" is already owned by module "a"/);
    assert.doesNotThrow(() => registry.register(manifest("d", { schema: "hijacked" })));
  });

  it("freezes what the registry returns, including nested arrays and the core manifest", () => {
    const registry = new Registry();
    const core = registry.registerCore();
    const a = registry.register({ ...manifest("a", needs("core")), nav: [{ label: "A", href: "/a" }] });
    for (const stored of [core, a]) {
      assert.throws(() => {
        stored.schema = "other";
      }, TypeError);
      assert.throws(() => {
        stored.version = "9.9.9";
      }, TypeError);
      assert.throws(() => {
        stored.dependsOn.x = "*";
      }, TypeError);
    }
    assert.throws(() => {
      a.nav.push({ label: "B", href: "/b" });
    }, TypeError);
    assert.throws(() => {
      a.nav[0]!.label = "changed";
    }, TypeError);
  });
});
