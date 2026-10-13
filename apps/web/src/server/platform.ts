import { type Auth, createAuth, resolveMasterKey } from "@epnexo/core/auth";
import { createPool, resolveDatabaseUrl } from "@epnexo/core/pool";
import type pg from "pg";

interface Platform {
  pool: pg.Pool;
  auth: Auth;
}

const STORE = Symbol.for("epnexo.web.platform");

/**
 * The pool and the authentication of this process, created on first use. Nothing is created at import time, so
 * `next build` can load every route module without a database or a master key. The instance is kept on
 * `globalThis` so development hot reloads do not open a new pool each time.
 */
export function platform(): Platform {
  const store = globalThis as typeof globalThis & { [STORE]?: Platform };
  if (store[STORE] === undefined) {
    const pool = createPool(resolveDatabaseUrl());
    // The library's background schema check stays on here: on a mismatch authentication requests fail loudly.
    store[STORE] = { pool, auth: createAuth({ pool, masterKey: resolveMasterKey() }) };
  }
  return store[STORE];
}
