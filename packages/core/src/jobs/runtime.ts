import { DB_READER, type DbReader, JOBS_ENQUEUER, type JobsEnqueuer, SETTINGS_READER, type SettingsReader } from "@modunexo/sdk";
import type pg from "pg";
import { resolveMasterKey } from "../auth/master-key.ts";
import { ModuleDbService } from "../data/module-db.ts";
import type { Registry } from "../registry.ts";
import { SettingsService } from "../settings/service.ts";
import { JobService } from "./service.ts";

/** The registry may be replaced while a long-lived process runs (modules are enabled or upgraded); readers look it up each call. */
export interface RegistryHolder {
  current: Registry;
}

/**
 * Registers, in this process, what a module's server code reaches through the SDK: `getDb`, `getSetting` and
 * `enqueueJob`. The web app does the same for requests; a worker does it so a job handler can do what a request can.
 * The master key is read only when a setting is, so a worker that never reads a secret does not need one.
 */
export function registerModuleRuntime(pool: pg.Pool, holder: RegistryHolder): void {
  const slot = globalThis as typeof globalThis & {
    [DB_READER]?: DbReader;
    [SETTINGS_READER]?: SettingsReader;
    [JOBS_ENQUEUER]?: JobsEnqueuer;
  };
  slot[DB_READER] = { forModule: (moduleId) => new ModuleDbService(pool, holder.current).forModule(moduleId) };
  slot[SETTINGS_READER] = { get: (moduleId, key) => new SettingsService(pool, holder.current, { masterKey: resolveMasterKey() }).get(moduleId, key) };
  slot[JOBS_ENQUEUER] = { enqueue: (moduleId, name, payload, options) => new JobService(pool, holder.current).enqueue(moduleId, name, payload, options) };
}
