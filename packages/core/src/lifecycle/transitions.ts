import { type ModuleManifest, SDK_VERSION } from "@modunexo/sdk";
import { gt, lt, satisfies, valid } from "semver";
import { CORE_MODULE_ID } from "../core-module.ts";
import { type Registry, compareIds } from "../registry.ts";

/**
 * The lifecycle rules, with no database and no I/O: given what is installed, what is on disk and what was
 * asked for, either the plan to carry out or a refusal that says why. The service (`service.ts`) performs
 * plans; the state store (`store.ts`) remembers them.
 */

/** A module that is merely available has no state: it is not in `core.modules` at all. */
export type LifecycleState = "enabled" | "disabled";
export type ModuleStatusKind = "available" | LifecycleState;
export type LifecycleAction = "install" | "enable" | "disable" | "upgrade" | "uninstall";
export type UninstallMode = "keep" | "purge";

/** One row of `core.modules`. */
export interface InstalledModule {
  id: string;
  state: LifecycleState;
  installedVersion: string;
}

export type RefusalCode =
  | "core_protected"
  | "unknown_module"
  | "already_installed"
  | "not_installed"
  | "already_enabled"
  | "already_disabled"
  | "platform_unsupported"
  | "dependency_missing"
  | "dependency_not_enabled"
  | "dependency_version_mismatch"
  | "invalid_installed_version"
  | "has_enabled_dependents"
  | "has_installed_dependents"
  | "downgrade"
  | "mode_required";

export interface Refusal {
  code: RefusalCode;
  message: string;
  /** The module ids the message names (missing dependencies, blocking dependents), sorted. Empty when none apply. */
  related: string[];
}

export interface TransitionRequest {
  action: LifecycleAction;
  moduleId: string;
  /** Required for `uninstall`; there is no default. */
  mode?: UninstallMode | undefined;
}

export interface TransitionPlan {
  action: LifecycleAction;
  moduleId: string;
  from: ModuleStatusKind;
  to: ModuleStatusKind;
  /** The version the module has once the action is done: the package version for install and upgrade, the installed one otherwise. */
  version: string;
  /** Upgrade only: the installed version being replaced. */
  previousVersion?: string;
  /** Uninstall only. */
  mode?: UninstallMode;
  /** Uninstall of an enabled module: it is disabled (its `onDisable` runs) before it is uninstalled. */
  disableFirst: boolean;
  /** Upgrade to the version already installed: there is nothing to do and nothing to record. */
  noop: boolean;
}

export type TransitionResult = { ok: true; plan: TransitionPlan } | { ok: false; refusal: Refusal };

const quoted = (ids: string[]) => ids.map((id) => `"${id}"`).join(", ");

function refuse(code: RefusalCode, message: string, related: string[] = []): TransitionResult {
  return { ok: false, refusal: { code, message, related } };
}

/** A stored version is only trusted when it is canonical semver; anything else cannot be compared and is flagged, not guessed at. */
export const isValidInstalledVersion = (version: string): boolean => valid(version) === version;

function invalidVersionProblem(id: string, version: string): TransitionResult {
  return refuse(
    "invalid_installed_version",
    `module "${id}" has an invalid installed version "${version}" recorded in core.modules; correct or remove that row before managing it`,
    [id],
  );
}

/**
 * Every dependency must have a package, be enabled, and be INSTALLED at a version inside the declared range.
 * The installed version (from `core.modules`) is what runs; the package on disk may already be newer while
 * its upgrade is pending, so it is deliberately not consulted for the range.
 */
function dependencyProblem(manifest: ModuleManifest, states: ReadonlyMap<string, InstalledModule>, registry: Registry): TransitionResult | undefined {
  const dependencies = Object.keys(manifest.dependsOn).sort(compareIds);
  const missing = dependencies.filter((id) => registry.get(id) === undefined);
  if (missing.length > 0) return refuse("dependency_missing", `module "${manifest.id}" depends on ${quoted(missing)}, which has no package on disk`, missing);
  const notEnabled = dependencies.filter((id) => states.get(id)?.state !== "enabled");
  if (notEnabled.length > 0) return refuse("dependency_not_enabled", `module "${manifest.id}" needs ${quoted(notEnabled)} to be enabled first`, notEnabled);

  const unreadable = dependencies.find((id) => !isValidInstalledVersion(states.get(id)!.installedVersion));
  if (unreadable !== undefined) return invalidVersionProblem(unreadable, states.get(unreadable)!.installedVersion);
  const mismatched = dependencies.filter((id) => !satisfies(states.get(id)!.installedVersion, manifest.dependsOn[id]!));
  if (mismatched.length > 0) {
    const detail = mismatched.map((id) => `"${id}" ${manifest.dependsOn[id]} but the installed version is ${states.get(id)!.installedVersion}`).join("; ");
    return refuse("dependency_version_mismatch", `module "${manifest.id}" requires ${detail}`, mismatched);
  }
  return undefined;
}

function platformProblem(manifest: ModuleManifest, registry: Registry): TransitionResult | undefined {
  if (registry.isPlatformSupported(manifest.id)) return undefined;
  return refuse("platform_unsupported", `module "${manifest.id}" requires platform "${manifest.platform}" but the SDK version is ${SDK_VERSION}`);
}

/** Ids of the modules that depend on `id`, directly or transitively, and are installed in one of `accepted`. */
function installedDependents(id: string, states: ReadonlyMap<string, InstalledModule>, registry: Registry, accepted: LifecycleState[]): string[] {
  return registry
    .transitiveDependentsOf(id)
    .filter((dependent) => {
      const state = states.get(dependent.id)?.state;
      return state !== undefined && accepted.includes(state);
    })
    .map((dependent) => dependent.id);
}

/**
 * Decide a lifecycle request. Pure: the result depends only on the arguments.
 * `states` holds the rows of `core.modules`; a module with no entry is available.
 */
export function planTransition(request: TransitionRequest, states: ReadonlyMap<string, InstalledModule>, registry: Registry): TransitionResult {
  const { action, moduleId } = request;
  if (moduleId === CORE_MODULE_ID) return refuse("core_protected", `the core module is part of the platform and cannot be managed (${action})`);

  const manifest = registry.get(moduleId);
  const installed = states.get(moduleId);
  if (manifest === undefined) {
    return refuse(
      "unknown_module",
      installed === undefined
        ? `module "${moduleId}" is unknown: there is no package for it`
        : `module "${moduleId}" is recorded as installed but its package is not on disk`,
    );
  }

  if (installed !== undefined && !isValidInstalledVersion(installed.installedVersion)) return invalidVersionProblem(moduleId, installed.installedVersion);

  const plan = (to: ModuleStatusKind, extra: Partial<TransitionPlan> = {}): TransitionResult => ({
    ok: true,
    plan: { action, moduleId, from: installed?.state ?? "available", to, version: installed?.installedVersion ?? manifest.version, disableFirst: false, noop: false, ...extra },
  });
  const requireInstalled = (): TransitionResult | undefined =>
    installed === undefined ? refuse("not_installed", `module "${moduleId}" is not installed`) : undefined;

  switch (action) {
    case "install": {
      if (installed !== undefined) return refuse("already_installed", `module "${moduleId}" is already installed (${installed.state})`);
      return platformProblem(manifest, registry) ?? dependencyProblem(manifest, states, registry) ?? plan("enabled", { version: manifest.version });
    }
    case "enable": {
      const problem = requireInstalled();
      if (problem) return problem;
      if (installed!.state === "enabled") return refuse("already_enabled", `module "${moduleId}" is already enabled`);
      return dependencyProblem(manifest, states, registry) ?? plan("enabled");
    }
    case "disable": {
      const problem = requireInstalled();
      if (problem) return problem;
      if (installed!.state === "disabled") return refuse("already_disabled", `module "${moduleId}" is already disabled`);
      const dependents = installedDependents(moduleId, states, registry, ["enabled"]);
      if (dependents.length > 0) return refuse("has_enabled_dependents", `cannot disable "${moduleId}": enabled modules depend on "${moduleId}": ${quoted(dependents)}`, dependents);
      return plan("disabled");
    }
    case "upgrade": {
      const problem = requireInstalled();
      if (problem) return problem;
      const previous = installed!.installedVersion;
      if (lt(manifest.version, previous)) {
        return refuse("downgrade", `module "${moduleId}": package version ${manifest.version} is lower than the installed ${previous}; downgrades are not supported`);
      }
      if (!gt(manifest.version, previous)) return plan(installed!.state, { noop: true });
      return platformProblem(manifest, registry) ?? plan(installed!.state, { version: manifest.version, previousVersion: previous });
    }
    case "uninstall": {
      const problem = requireInstalled();
      if (problem) return problem;
      const dependents = installedDependents(moduleId, states, registry, ["enabled", "disabled"]);
      if (dependents.length > 0) return refuse("has_installed_dependents", `cannot uninstall "${moduleId}": installed modules depend on "${moduleId}": ${quoted(dependents)}`, dependents);
      if (request.mode !== "keep" && request.mode !== "purge") {
        return refuse("mode_required", `uninstall of "${moduleId}" needs an explicit mode: keep (leave the schema and migration history) or purge (drop them)`);
      }
      return plan("available", { mode: request.mode, disableFirst: installed!.state === "enabled" });
    }
  }
}
