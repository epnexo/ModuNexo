import pg from "pg";

type Env = Record<string, string | undefined>;
type Log = (...args: unknown[]) => void;

/** The connection string from `DATABASE_URL`. Throws a recognisable error when it is not set. */
export function resolveDatabaseUrl(env: Env = process.env): string {
  const url = env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return url;
}

/**
 * A pool that survives errors on idle clients. `pg` emits `error` when a pooled connection drops while nobody
 * is using it (database restart, network cut); without a listener Node treats that as an uncaught exception.
 * The client is already removed from the pool when this fires, so logging is all that is needed.
 */
export function createPool(connectionString: string, options: pg.PoolConfig = {}, log: Log = console.error): pg.Pool {
  const pool = new pg.Pool({ connectionString, ...options });
  pool.on("error", (error) => log("idle database client error:", error.message));
  return pool;
}

declare global {
  // Kept on globalThis so a dev server that reloads modules does not leak a new pool each time.
  var __epnexoPool: pg.Pool | undefined;
}

/**
 * The shared server-side pool. Created lazily on first use so that importing this module never connects.
 * Short timeouts keep a page from hanging when the database is down.
 */
export function getPool(): pg.Pool {
  globalThis.__epnexoPool ??= createPool(resolveDatabaseUrl(), {
    max: 5,
    connectionTimeoutMillis: 3000,
    statement_timeout: 15000,
  });
  return globalThis.__epnexoPool;
}
