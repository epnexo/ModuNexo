import { type Auth, createAuth, resolveMasterKey } from "@epnexo/core/auth";
import { createPool, resolveDatabaseUrl } from "@epnexo/core/pool";
import type pg from "pg";
import { resolvePublicUrl } from "./launch.ts";

interface Platform {
  pool: pg.Pool;
  auth: Auth;
}

const STORE = Symbol.for("epnexo.web.platform");
const CLOSED = Symbol.for("epnexo.web.platform.closed");
const store = () => globalThis as typeof globalThis & { [STORE]?: Platform; [CLOSED]?: true };

/**
 * The pool and the authentication of this process, created on first use. Nothing is created at import time, so
 * `next build` can load every route module without a database or a master key. The instance is kept on
 * `globalThis` so development hot reloads do not open a new pool each time, and so the server entry, which Next.js
 * bundles separately, can close the same pool on shutdown.
 */
export function platform(): Platform {
  const holder = store();
  // After shutdown began, a late request must not build a new pool that nothing will ever close.
  if (holder[CLOSED] === true) throw new Error("the server is shutting down");
  if (holder[STORE] === undefined) {
    // Everything that can fail on configuration is resolved before the pool exists, so a bad setting cannot leave
    // a pool open that nothing will ever close.
    const masterKey = resolveMasterKey();
    const databaseUrl = resolveDatabaseUrl();
    const { baseURL, secureCookies } = resolvePublicUrl();
    const pool = createPool(databaseUrl);
    // The library's background schema check stays on here: on a mismatch authentication requests fail loudly.
    holder[STORE] = { pool, auth: createAuth({ pool, masterKey, secureCookies, ...(baseURL === undefined ? {} : { baseURL }) }) };
  }
  return holder[STORE];
}

/** Allows `platform()` again after `closePlatform()`. Only tests need it: a server that stopped does not restart. */
export function reopenPlatform(): void {
  delete store()[CLOSED];
}

/** Ends the pool, if one was created. Called once, when the server is stopping. */
export async function closePlatform(): Promise<void> {
  const holder = store();
  holder[CLOSED] = true;
  const current = holder[STORE];
  if (current === undefined) return;
  delete holder[STORE];
  await current.pool.end();
}
