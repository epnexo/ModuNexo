import { DB_READER, type DbReader, EVENTS_PUBLISHER, type EventsPublisher, FILES_SERVICE, type FilesService, JOBS_ENQUEUER, type JobsEnqueuer, SETTINGS_READER, type SettingsReader } from "@modunexo/sdk";
import type pg from "pg";
import { resolveMasterKey } from "../auth/master-key.ts";
import { ModuleDbService } from "../data/module-db.ts";
import { EventService } from "../events/service.ts";
import { FileService } from "../files/service.ts";
import { defaultFileStorage } from "../files/index.ts";
import type { Registry } from "../registry.ts";
import { SettingsService } from "../settings/service.ts";
import { JobService } from "./service.ts";

/** The registry may be replaced while a long-lived process runs (modules are enabled or upgraded); readers look it up each call. */
export interface RegistryHolder {
  current: Registry;
}

/**
 * Registers, in this process, what a module's server code reaches through the SDK: `getDb`, `getSetting`,
 * `enqueueJob`, `publishEvent` and the file functions. The web app does the same for requests; a worker does it so a job handler can do what a request can.
 * The master key is read only when a setting is, so a worker that never reads a secret does not need one.
 */
export function registerModuleRuntime(pool: pg.Pool, holder: RegistryHolder): void {
  const slot = globalThis as typeof globalThis & {
    [DB_READER]?: DbReader;
    [SETTINGS_READER]?: SettingsReader;
    [JOBS_ENQUEUER]?: JobsEnqueuer;
    [EVENTS_PUBLISHER]?: EventsPublisher;
    [FILES_SERVICE]?: FilesService;
  };
  slot[DB_READER] = { forModule: (moduleId) => new ModuleDbService(pool, holder.current).forModule(moduleId) };
  slot[SETTINGS_READER] = { get: (moduleId, key) => new SettingsService(pool, holder.current, { masterKey: resolveMasterKey() }).get(moduleId, key) };
  slot[JOBS_ENQUEUER] = { enqueue: (moduleId, name, payload, options) => new JobService(pool, holder.current).enqueue(moduleId, name, payload, options) };
  slot[EVENTS_PUBLISHER] = { publish: (moduleId, name, payload, options) => new EventService(pool, holder.current).publish(moduleId, name, payload, options) };
  // The adapter is chosen on each call, so the data directory is read when a file is used, not when the process starts.
  const files = () => new FileService(pool, holder.current, defaultFileStorage());
  slot[FILES_SERVICE] = {
    put: (moduleId, input, options) => files().put(moduleId, input, options),
    get: (moduleId, id) => files().get(moduleId, id),
    stat: (moduleId, id) => files().stat(moduleId, id),
    list: (moduleId, options) => files().list(moduleId, options),
    remove: (moduleId, id) => files().remove(moduleId, id),
  };
}
