import pg from "pg";
import { createPool } from "./pool.ts";
import { quoteIdentifier } from "./sql.ts";

type Env = Record<string, string | undefined>;

function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
}

/**
 * The database integration tests run against, never the development one.
 * `TEST_DATABASE_URL` wins; otherwise it is `DATABASE_URL` with `_test` appended to the database name.
 * Returns undefined when neither is set. Throws when the result could be the development database.
 */
export function resolveTestDatabaseUrl(env: Env = process.env): string | undefined {
  const explicit = env.TEST_DATABASE_URL;
  const development = env.DATABASE_URL;
  let url = explicit;
  if (!url) {
    if (!development) return undefined;
    const derived = new URL(development);
    derived.pathname = `/${databaseName(development)}_test`;
    url = derived.toString();
  }
  if (development && databaseName(url) === databaseName(development) && new URL(url).host === new URL(development).host) {
    throw new Error("TEST_DATABASE_URL must not be the development database");
  }
  if (!databaseName(url).endsWith("_test")) {
    throw new Error(`TEST_DATABASE_URL database "${databaseName(url)}" must end with "_test"`);
  }
  return url;
}

export interface TestPool {
  pool?: pg.Pool;
  /** Why no pool is available; integration tests should skip with this message. Set only when the server is down or unconfigured. */
  skipReason?: string;
}

const NETWORK_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ECONNRESET"]);
const ALREADY_EXISTS = new Set(["42P04", "23505"]);

/**
 * Whether an error means no database server answered at all. Anything else (bad credentials, a missing
 * permission, a refused statement) means a server is there and the setup is wrong, which must not be skipped.
 */
export function isServerUnreachable(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && NETWORK_CODES.has(code)) return true;
  return /^timeout expired$|Connection terminated/i.test(error instanceof Error ? error.message : "");
}

/**
 * Connect to the test database, creating it on the same server when missing.
 *
 * Two situations are kept apart on purpose:
 * - no server answers (or nothing is configured): resolves with a `skipReason`, and the tests skip visibly;
 * - a server answers but the database cannot be created or reached: throws, so the suite fails.
 * A misconfiguration (a name that fails the `_test` guard, or the development database) throws as well.
 */
export async function openTestPool(env: Env = process.env): Promise<TestPool> {
  const url = resolveTestDatabaseUrl(env);
  if (!url) return { skipReason: "neither TEST_DATABASE_URL nor DATABASE_URL is set (copy .env.example to .env and run `docker compose up -d db`)" };

  try {
    const admin = new URL(url);
    admin.pathname = "/postgres";
    const client = new pg.Client({ connectionString: admin.toString(), connectionTimeoutMillis: 2000 });
    await client.connect();
    try {
      await ensureDatabase(client, databaseName(url));
    } finally {
      await client.end();
    }
    const pool = createPool(url, { connectionTimeoutMillis: 2000 });
    try {
      await pool.query("select 1");
    } catch (error) {
      await pool.end();
      throw error;
    }
    return { pool };
  } catch (error) {
    if (isServerUnreachable(error)) return { skipReason: `test database server is unreachable (${(error as Error).message})` };
    throw new Error(`test database "${databaseName(url)}" could not be prepared: ${(error as Error).message}`, { cause: error });
  }
}

async function ensureDatabase(client: pg.Client, name: string): Promise<void> {
  const exists = await client.query("select 1 from pg_database where datname = $1", [name]);
  if (exists.rowCount === 0) {
    // Test processes run in parallel, so another one may create it between the check and here.
    await client.query(`create database ${quoteIdentifier(name)}`).catch((error: { code?: string }) => {
      if (!ALREADY_EXISTS.has(error.code ?? "")) throw error;
    });
  }
}
