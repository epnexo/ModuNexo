import { Registry } from "@epnexo/core/registry";
import type pg from "pg";
import { modules } from "../generated/modules.ts";

let cached: Registry | undefined;

/** A registry of the modules this build was generated with, for the services that check a module id or its settings. */
export function webRegistry(): Registry {
  if (cached === undefined) {
    const registry = new Registry();
    registry.registerCore();
    for (const manifest of modules) registry.register(manifest);
    cached = registry;
  }
  return cached;
}

/**
 * The ids of the modules the database says are enabled. The registry above is fixed when the app is built, so
 * after an uninstall it still lists the module until the next build; anything that changes or shows a module's
 * data asks this as well, so a stale build cannot bring a purged module's rows back.
 */
export async function enabledModuleIds(pool: pg.Pool): Promise<Set<string>> {
  const { rows } = await pool.query("select id from core.modules where state = 'enabled'");
  return new Set((rows as { id: string }[]).map((row) => row.id));
}
