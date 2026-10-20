import type pg from "pg";
import { CORE_MODULE_ID } from "./core-module.ts";
import type { Registry } from "./registry.ts";
import { type MigrateOptions, withMigrationLock } from "./runner.ts";
import { quoteIdentifier } from "./sql.ts";

const PROTECTED_SCHEMAS = new Set(["public", "information_schema", "core"]);

/**
 * Drop a module's schema (cascade) and delete its rows from `core.schema_migrations`, in one transaction
 * and under the migration lock. This is the data-destroying half of an uninstall.
 *
 * The schema is read from the registry, so only a schema the registry attributes to this module can be
 * dropped. The core module and the reserved schemas are refused, and the name is validated and quoted
 * rather than interpolated as given.
 */
export async function purgeModule(pool: pg.Pool, registry: Registry, moduleId: string, options: MigrateOptions = {}): Promise<void> {
  const target = purgeTarget(registry, moduleId);
  await withMigrationLock(pool, options, (client) => dropModule(client, target));
}

/** `purgeModule` for a caller that already holds the migration lock on `client`; see `migrateModuleLocked`. */
export async function purgeModuleLocked(client: pg.PoolClient, registry: Registry, moduleId: string): Promise<void> {
  await dropModule(client, purgeTarget(registry, moduleId));
}

/**
 * The statements of a purge for a caller that owns the transaction: nothing is begun, committed or rolled back
 * here, so the lifecycle can put the purge and the removal of the module's row into one commit. The caller must
 * hold the migration lock on `client` and have begun a transaction; on an error it must roll that transaction back.
 */
export async function purgeModuleInTransaction(client: pg.PoolClient, registry: Registry, moduleId: string): Promise<void> {
  const target = purgeTarget(registry, moduleId);
  try {
    await dropStatements(client, target);
  } catch (error) {
    throw purgeFailure(target, error);
  }
}

interface PurgeTarget {
  id: string;
  schema: string;
}

function purgeTarget(registry: Registry, moduleId: string): PurgeTarget {
  if (moduleId === CORE_MODULE_ID) throw new Error("cannot purge the core module");
  const manifest = registry.get(moduleId);
  if (manifest === undefined) throw new Error(`module "${moduleId}" is not registered`);
  if (PROTECTED_SCHEMAS.has(manifest.schema)) throw new Error(`refusing to purge schema "${manifest.schema}" of module "${moduleId}"`);
  quoteIdentifier(manifest.schema);
  return { id: manifest.id, schema: manifest.schema };
}

async function dropStatements(client: pg.PoolClient, target: PurgeTarget): Promise<void> {
  await client.query(`drop schema if exists ${quoteIdentifier(target.schema)} cascade`);
  // Before the core's first migration there is no history table, so there is nothing to delete.
  const tracked = await client.query("select to_regclass('core.schema_migrations') is not null as present");
  if (tracked.rows[0].present) {
    await client.query("delete from core.schema_migrations where module_id = $1", [target.id]);
  }
  // The module's settings go with its data. The audit trail in core.settings_events stays, and holds no values.
  const settings = await client.query("select to_regclass('core.module_settings') is not null as present");
  if (settings.rows[0].present) {
    await client.query("delete from core.module_settings where module_id = $1", [target.id]);
  }
  // So does the module's own appearance override, which lives next to the platform's in platform_settings.
  const platform = await client.query("select to_regclass('core.platform_settings') is not null as present");
  if (platform.rows[0].present) {
    await client.query("delete from core.platform_settings where starts_with(key, $1)", [`appearance.module.${target.id}.`]);
  }
  // Its service tokens go too, so a module installed later under the same id inherits no access. The audit trail in
  // core.service_token_events stays, and holds no token.
  const tokens = await client.query("select to_regclass('core.service_tokens') is not null as present");
  if (tokens.rows[0].present) {
    await client.query("delete from core.service_tokens where module_id = $1", [target.id]);
  }
  // And its queued, running and finished jobs: a module installed later under the same id starts with an empty queue.
  const jobs = await client.query("select to_regclass('core.jobs') is not null as present");
  if (jobs.rows[0].present) {
    await client.query("delete from core.jobs where module_id = $1", [target.id]);
  }
}

const purgeFailure = (target: PurgeTarget, error: unknown): Error =>
  new Error(`purging module "${target.id}" failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });

async function dropModule(client: pg.PoolClient, target: PurgeTarget): Promise<void> {
  try {
    await client.query("begin");
    await dropStatements(client, target);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw purgeFailure(target, error);
  }
}
