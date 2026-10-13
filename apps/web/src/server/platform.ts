import { type Auth, createAuth, resolveMasterKey } from "@epnexo/core/auth";
import { createPool, resolveDatabaseUrl } from "@epnexo/core/pool";
import { SettingsService } from "@epnexo/core/settings";
import { SETTINGS_READER, type SettingsReader } from "@epnexo/sdk";
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
