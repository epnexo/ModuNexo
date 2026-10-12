import { SDK_VERSION, type ModuleManifest, validateManifest } from "@epnexo/sdk";
import { satisfies } from "semver";
import { CORE_MODULE_ID, coreManifest } from "./core-module.ts";

/**
 * The one ordering for module ids: plain code-unit comparison, so the result never depends on the host locale.
 * Every place that orders ids (install order tie-breaks, dependents, problem reports) uses it.
 */
export const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Freeze an object and everything reachable from it. */
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Holds module manifests and resolves the order in which modules are installed. */
export class Registry {
  readonly #modules = new Map<string, ModuleManifest>();
  readonly #schemaOwners = new Map<string, string>();

  /**
   * Validate and add a module manifest. Rejects the reserved core id, a `platform` range the SDK does not
   * satisfy, duplicate ids, and schemas already owned by another module.
   */
  register(input: unknown): ModuleManifest {
    const manifest = validateManifest(input);
    if (manifest.id === CORE_MODULE_ID) {
      throw new Error(`module id "${CORE_MODULE_ID}" is reserved for the platform`);
    }
    return this.#add(manifest);
  }

  /** Add the platform's own core manifest. This is the only way the reserved `core` schema is admitted. */
  registerCore(): ModuleManifest {
    return this.#add(validateManifest(coreManifest, { allowCoreSchema: true }));
  }

  #add(admitted: ModuleManifest): ModuleManifest {
    // Admit a frozen copy: later changes to the caller's object cannot alter what the registry returns.
    const manifest = deepFreeze(structuredClone(admitted));
    if (!satisfies(SDK_VERSION, manifest.platform)) {
      throw new Error(`module "${manifest.id}" requires platform "${manifest.platform}" but the SDK version is ${SDK_VERSION}`);
    }
    if (this.#modules.has(manifest.id)) {
      throw new Error(`module "${manifest.id}" is already registered`);
    }
    const owner = this.#schemaOwners.get(manifest.schema);
    if (owner !== undefined) {
      throw new Error(`schema "${manifest.schema}" is already owned by module "${owner}" (cannot also belong to "${manifest.id}")`);
    }
    this.#modules.set(manifest.id, manifest);
    this.#schemaOwners.set(manifest.schema, manifest.id);
    return manifest;
  }

  get(id: string): ModuleManifest | undefined {
    return this.#modules.get(id);
  }

  /**
   * Dependencies as installation sees them: the declared ones, plus the core for every other module
   * so that the core's tables exist before anything else runs.
   */
  #dependenciesOf(manifest: ModuleManifest): string[] {
    const deps = new Set(Object.keys(manifest.dependsOn));
    if (manifest.id !== CORE_MODULE_ID && this.#modules.has(CORE_MODULE_ID)) deps.add(CORE_MODULE_ID);
    return [...deps].sort(compareIds);
  }

  /**
   * Everything wrong with the dependency graph, without throwing: unknown dependencies, dependencies whose
   * version misses the declared range, and the first dependency cycle. Empty when the graph can be ordered.
   *
   * Ranges follow semver's default prerelease rule, kept on purpose: a prerelease dependency (`1.0.0-rc.1`)
   * does not satisfy an ordinary range (`^1.0.0`) and is reported as a mismatch; it satisfies only a range
   * that names its own prerelease line (`^1.0.0-rc.0`). `includePrerelease` is deliberately not enabled.
   */
  problems(): string[] {
    const ids = [...this.#modules.keys()].sort(compareIds);
    const problems: string[] = [];

    for (const id of ids) {
      const manifest = this.#modules.get(id)!;
      for (const [dep, range] of Object.entries(manifest.dependsOn).sort(([a], [b]) => compareIds(a, b))) {
        const target = this.#modules.get(dep);
        if (target === undefined) {
          problems.push(`module "${id}" depends on unknown module "${dep}"`);
        } else if (!satisfies(target.version, range)) {
          problems.push(`module "${id}" requires "${dep}" ${range} but version ${target.version} is registered`);
        }
      }
    }

    const cycle = this.#findCycle(ids);
    if (cycle !== undefined) problems.push(`dependency cycle: ${cycle.join(" -> ")}`);
    return problems;
  }

  /** Modules in installation order: dependencies first, ties broken by id. Throws when `problems()` is not empty. */
  resolveOrder(): ModuleManifest[] {
    const problems = this.problems();
    if (problems.length > 0) {
      throw new Error(problems.length === 1 ? problems[0]! : `invalid module graph:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    }

    const ids = [...this.#modules.keys()].sort(compareIds);
    const remaining = new Map(ids.map((id) => [id, new Set(this.#dependenciesOf(this.#modules.get(id)!))]));
    const ordered: ModuleManifest[] = [];
    while (remaining.size > 0) {
      const next = [...remaining.entries()].find(([, deps]) => deps.size === 0)?.[0];
      // Unreachable once problems() is empty; kept as a guard against future edits.
      if (next === undefined) throw new Error("could not resolve module order");
      ordered.push(this.#modules.get(next)!);
      remaining.delete(next);
      for (const deps of remaining.values()) deps.delete(next);
    }
    return ordered;
  }

  /** The first dependency cycle in id order, as the path that closes it, or `undefined`. Unknown dependencies are skipped. */
  #findCycle(sortedIds: string[]): string[] | undefined {
    const done = new Set<string>();
    const path: string[] = [];

    const visit = (id: string): string[] | undefined => {
      const at = path.indexOf(id);
      if (at !== -1) return [...path.slice(at), id];
      if (done.has(id)) return undefined;
      path.push(id);
      for (const dep of this.#dependenciesOf(this.#modules.get(id)!)) {
        if (!this.#modules.has(dep)) continue;
        const found = visit(dep);
        if (found !== undefined) return found;
      }
      path.pop();
      done.add(id);
      return undefined;
    };

    for (const id of sortedIds) {
      const found = visit(id);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  /** The modules that depend directly on `id` (the core counts as a dependency of every other module), sorted by id. */
  dependentsOf(id: string): ModuleManifest[] {
    return [...this.#modules.values()]
      .filter((manifest) => this.#dependenciesOf(manifest).includes(id))
      .sort((a, b) => compareIds(a.id, b.id));
  }

  /** The modules that depend on `id` directly or through other modules, sorted by id, never including `id` itself. */
  transitiveDependentsOf(id: string): ModuleManifest[] {
    const found = new Map<string, ModuleManifest>();
    const queue = [id];
    while (queue.length > 0) {
      for (const dependent of this.dependentsOf(queue.shift()!)) {
        if (dependent.id === id || found.has(dependent.id)) continue;
        found.set(dependent.id, dependent);
        queue.push(dependent.id);
      }
    }
    return [...found.values()].sort((a, b) => compareIds(a.id, b.id));
  }
}
