import { isAbsolute, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type pg from "pg";
import type { ModuleManifest } from "@epnexo/sdk";
import { CORE_MODULE_DIR, CORE_MODULE_ID } from "./core-module.ts";
import { type MigrationFile, planMigrations, readMigrationFiles } from "./migrations.ts";
import type { Registry } from "./registry.ts";
import { quoteIdentifier } from "./sql.ts";

export interface AppliedMigration {
  moduleId: string;
  filename: string;
}

export interface MigrateResult {
  applied: AppliedMigration[];
}

export interface MigrateOptions {
  /**
   * Module id to the folder its relative `migrationsDir` resolves against. The core's folder is built in;
   * a module with an absolute `migrationsDir` (as discovery produces) needs no entry.
   */
  moduleDirs?: Record<string, string>;
  /** How long to wait for the migration lock before failing. Default 30 000 ms. */
  lockTimeoutMs?: number;
  /** Pause between attempts to take the lock. Default 100 ms. */
  lockPollMs?: number;
}

/**
 * A migration run that stopped partway. `applied` lists what this run had already committed before the
 * failure (those files stay applied: each file is its own transaction), so a caller can report it.
 * `message` and `cause` are those of the underlying failure.
 */
export class MigrationRunError extends Error {
  constructor(
    message: string,
    readonly applied: AppliedMigration[],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MigrationRunError";
  }
}

export const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_POLL_MS = 100;

// Serializes concurrent runs (two deploys, a test and a CLI) on one database. Purge takes the same lock.
export const MIGRATION_LOCK_NAME = "epnexo.platform.migrate";

/**
 * Apply pending migrations for every module in dependency order, under the migration lock.
 *
 * Bootstrap: the tracking table `core.schema_migrations` is created by the core's own first migration,
 * which is idempotent. Until that table exists, nothing is recorded as applied, so the core's
 * `0001_init.sql` runs, creates the table, and is recorded in the same transaction.
 */
export async function migrate(pool: pg.Pool, registry: Registry, options: MigrateOptions = {}): Promise<MigrateResult> {
  const order = registry.resolveOrder();
  requireCore(registry);
  return withMigrationLock(pool, options, (client) => applyModules(client, order, options));
}

/**
 * Apply pending migrations for one module, after bringing the core itself up to date so that the tracking
 * table exists. Same lock, guards and per-file transactions as `migrate`. The lifecycle calls this for
 * install and upgrade; it does not check dependencies, which the lifecycle owns.
 */
export async function migrateModule(pool: pg.Pool, registry: Registry, moduleId: string, options: MigrateOptions = {}): Promise<MigrateResult> {
  const modules = modulesFor(registry, moduleId);
  return withMigrationLock(pool, options, (client) => applyModules(client, modules, options));
}

/**
 * `migrateModule` for a caller that already holds the migration lock on `client` (the lifecycle service,
 * which keeps the lock for a whole action). Taking the lock again from another connection would wait on
 * itself, so this variant never locks; calling it without holding the lock is a bug.
 */
export async function migrateModuleLocked(client: pg.PoolClient, registry: Registry, moduleId: string, options: MigrateOptions = {}): Promise<MigrateResult> {
  return applyModules(client, modulesFor(registry, moduleId), options);
}

function modulesFor(registry: Registry, moduleId: string): ModuleManifest[] {
  const manifest = registry.get(moduleId);
  if (manifest === undefined) throw new Error(`module "${moduleId}" is not registered`);
  const core = requireCore(registry);
  return manifest.id === core.id ? [core] : [core, manifest];
}

function requireCore(registry: Registry): ModuleManifest {
  const core = registry.get(CORE_MODULE_ID);
  if (core === undefined) throw new Error("the core module is not registered; call registry.registerCore() first");
  return core;
}

/**
 * Run `work` on a dedicated connection holding the session-level migration lock. The wait for the lock is
 * bounded: it is retried with `pg_try_advisory_lock` until the timeout, then fails with a clear error.
 */
export async function withMigrationLock<T>(pool: pg.Pool, options: MigrateOptions, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const timeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const pollMs = options.lockPollMs ?? DEFAULT_LOCK_POLL_MS;
  const client = await pool.connect();
  try {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { rows } = await client.query("select pg_try_advisory_lock(hashtext($1)) as locked", [MIGRATION_LOCK_NAME]);
      if (rows[0]?.locked === true) break;
      if (Date.now() >= deadline) {
        throw new Error(`could not acquire the migration lock within ${timeoutMs} ms; another migration may be running`);
      }
      await sleep(pollMs);
    }
  } catch (error) {
    client.release();
    throw error;
  }

  try {
    return await work(client);
  } finally {
    // A failed unlock must not replace the error that is already propagating. The connection is then
    // in an unknown state, so it is destroyed (release(true)), which also drops the session-level lock.
    let unlockFailed = false;
    try {
      await client.query("select pg_advisory_unlock(hashtext($1))", [MIGRATION_LOCK_NAME]);
    } catch {
      unlockFailed = true;
    } finally {
      client.release(unlockFailed);
    }
  }
}

async function applyModules(client: pg.PoolClient, modules: ModuleManifest[], options: MigrateOptions): Promise<MigrateResult> {
  const applied: AppliedMigration[] = [];
  try {
    for (const manifest of modules) {
      // Plan first: a refused plan (missing directory, bad names, rewritten history) must not leave an empty schema behind.
      let pending: MigrationFile[];
      try {
        const files = readMigrationFiles(migrationsPath(manifest, options.moduleDirs ?? {}));
        pending = planMigrations(files, await loadApplied(client, manifest.id));
      } catch (error) {
        throw new Error(`module "${manifest.id}": ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
      await client.query(`create schema if not exists ${quoteIdentifier(manifest.schema)}`);
      for (const file of pending) {
        await applyFile(client, manifest, file);
        applied.push({ moduleId: manifest.id, filename: file.filename });
      }
    }
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    throw new MigrationRunError(failure.message, applied, { cause: failure.cause ?? failure });
  }
  return { applied };
}

function migrationsPath(manifest: ModuleManifest, moduleDirs: Record<string, string>): string {
  const dir = moduleDirs[manifest.id] ?? (manifest.id === CORE_MODULE_ID ? CORE_MODULE_DIR : undefined);
  if (dir !== undefined) return resolve(dir, manifest.migrationsDir);
  if (isAbsolute(manifest.migrationsDir)) return manifest.migrationsDir;
  throw new Error(`relative migrationsDir "${manifest.migrationsDir}" and no module directory is known for it (pass moduleDirs)`);
}

async function loadApplied(client: pg.PoolClient, moduleId: string): Promise<Map<string, string>> {
  const exists = await client.query("select to_regclass('core.schema_migrations') is not null as present");
  if (!exists.rows[0].present) return new Map();
  const rows = await client.query("select filename, checksum from core.schema_migrations where module_id = $1", [moduleId]);
  return new Map(rows.rows.map((row) => [row.filename as string, row.checksum as string]));
}

async function applyFile(client: pg.PoolClient, manifest: ModuleManifest, file: MigrationFile): Promise<void> {
  try {
    await client.query("begin");
    await client.query(`set local search_path to ${quoteIdentifier(manifest.schema)}`);
    await client.query(file.sql);
    await client.query("insert into core.schema_migrations (module_id, filename, checksum) values ($1, $2, $3)", [
      manifest.id,
      file.filename,
      file.checksum,
    ]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`migration ${manifest.id}/${file.filename} failed: ${message}`, { cause: error });
  }
}
