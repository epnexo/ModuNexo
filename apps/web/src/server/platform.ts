import { type Auth, createAuth, resolveMasterKey } from "@modunexo/core/auth";
import { createPool, resolveDatabaseUrl } from "@modunexo/core/pool";
import { SettingsService } from "@modunexo/core/settings";
import { ModuleDbService } from "@modunexo/core/data";
import { EventService } from "@modunexo/core/events";
import { JobService } from "@modunexo/core/jobs";
import { DB_READER, EVENTS_PUBLISHER, JOBS_ENQUEUER, SETTINGS_READER, type DbReader, type EventsPublisher, type JobsEnqueuer, type SettingsReader } from "@modunexo/sdk";
import type pg from "pg";
import { resolvePublicUrl } from "./launch.ts";
import { CLOSED, STORE, closePlatform, holder, reopenPlatform } from "./platform-lifecycle.ts";
import { webRegistry } from "./registry.ts";

interface Platform {
  pool: pg.Pool;
  auth: Auth;
}

/**
 * The pool and the authentication of this process, created on first use. Nothing is created at import time, so
 * `next build` can load every route module without a database or a master key. The instance is kept on
 * `globalThis` so development hot reloads do not open a new pool each time, and so the server entry, which Next.js
 * bundles separately, can close the same pool on shutdown.
 */
export function platform(): Platform {
  const state = holder() as unknown as { [STORE]?: Platform; [CLOSED]?: true };
  // After shutdown began, a late request must not build a new pool that nothing will ever close.
  if (state[CLOSED] === true) throw new Error("the server is shutting down");
  if (state[STORE] === undefined) {
    // Everything that can fail on configuration is resolved before the pool exists, so a bad setting cannot leave
    // a pool open that nothing will ever close.
    const masterKey = resolveMasterKey();
    const databaseUrl = resolveDatabaseUrl();
    const { baseURL, secureCookies } = resolvePublicUrl();
    const pool = createPool(databaseUrl);
    // The library's background schema check stays on here: on a mismatch authentication requests fail loudly.
    state[STORE] = { pool, auth: createAuth({ pool, masterKey, secureCookies, ...(baseURL === undefined ? {} : { baseURL }) }) };
  }
  return state[STORE];
}

export { closePlatform, reopenPlatform };

/**
 * What `getSetting` in the SDK calls. Registered when this module is first evaluated, which the access gate does
 * on every process before any page or route handler runs, so a module's server code can read its settings from a
 * page and from an API route alike. The pool and the master key are only touched when a setting is read.
 */
const settingsReader: SettingsReader = {
  get: (moduleId, key) => new SettingsService(platform().pool, webRegistry(), { masterKey: resolveMasterKey() }).get(moduleId, key),
};
(globalThis as typeof globalThis & { [SETTINGS_READER]?: SettingsReader })[SETTINGS_READER] = settingsReader;

/**
 * What `getDb` in the SDK calls, registered the same way and for the same reason as the settings reader. The handle
 * a module gets is built per call from the build's registry; the pool is only touched when a statement runs.
 */
const dbReader: DbReader = {
  forModule: (moduleId) => new ModuleDbService(platform().pool, webRegistry()).forModule(moduleId),
};
(globalThis as typeof globalThis & { [DB_READER]?: DbReader })[DB_READER] = dbReader;

/**
 * What `enqueueJob` in the SDK calls, registered the same way. The web app only queues: the jobs run in the worker
 * process (`modunexo worker`), which shares the database. The build's registry says which jobs a module declared.
 */
const jobsEnqueuer: JobsEnqueuer = {
  enqueue: (moduleId, name, payload, options) => new JobService(platform().pool, webRegistry()).enqueue(moduleId, name, payload, options),
};
(globalThis as typeof globalThis & { [JOBS_ENQUEUER]?: JobsEnqueuer })[JOBS_ENQUEUER] = jobsEnqueuer;

/**
 * What `publishEvent` in the SDK calls. With the caller's transaction the event commits with the caller's data; the web
 * app's own streams and the worker's jobs hear about it through the database, whichever process published it.
 */
const eventsPublisher: EventsPublisher = {
  publish: (moduleId, name, payload, options) => new EventService(platform().pool, webRegistry()).publish(moduleId, name, payload, options),
};
(globalThis as typeof globalThis & { [EVENTS_PUBLISHER]?: EventsPublisher })[EVENTS_PUBLISHER] = eventsPublisher;
