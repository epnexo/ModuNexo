import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type pg from "pg";
import type { ModuleManifest } from "@epnexo/sdk";
import type { UninstallMode } from "./transitions.ts";

/**
 * What a hook is told. `version` is the version the module has once the action is done (the package
 * version for install and upgrade, the installed one otherwise); `previousVersion` is set for upgrade only
 * and `mode` for uninstall only. `db` is the pool: hooks use their own connections.
 *
 * A hook runs while the lifecycle holds the migration lock, so it must not run migrations or lifecycle
 * actions itself (it would wait for the lock its own caller holds). Hooks may run again on a retry after a
 * failed action, so they should be idempotent.
 */
export interface HookContext {
  moduleId: string;
  version: string;
  previousVersion?: string;
  mode?: UninstallMode;
  db: pg.Pool;
}

export type Hook = (context: HookContext) => void | Promise<void>;

/** The optional exports of a module's `hooks` entry. */
export interface ModuleHooks {
  onInstall?: Hook;
  onEnable?: Hook;
  onDisable?: Hook;
  onUpgrade?: Hook;
  onUninstall?: Hook;
}

export type HookName = keyof ModuleHooks;

/** Produces a module's hooks. Injected into the service so tests never touch the filesystem. */
export type HookLoader = (manifest: ModuleManifest) => Promise<ModuleHooks | undefined>;

const HOOK_NAMES: HookName[] = ["onInstall", "onEnable", "onDisable", "onUpgrade", "onUninstall"];

/**
 * The default loader: imports the manifest's `hooks` entry, a path relative to `<modulesDir>/<id>/`, and
 * returns the hook functions it exports. A module without `hooks`, or an entry that exports none of them,
 * is fine; an export with a hook's name that is not a function is an error.
 */
export function fileHookLoader(modulesDir: string): HookLoader {
  return async (manifest) => {
    if (manifest.hooks === undefined) return undefined;
    const file = resolve(modulesDir, manifest.id, manifest.hooks);
    const loaded: Record<string, unknown> = await import(pathToFileURL(file).href);
    const hooks: ModuleHooks = {};
    for (const name of HOOK_NAMES) {
      const value = loaded[name];
      if (value === undefined) continue;
      if (typeof value !== "function") throw new Error(`hook "${name}" exported by ${file} must be a function`);
      hooks[name] = value as Hook;
    }
    return hooks;
  };
}
