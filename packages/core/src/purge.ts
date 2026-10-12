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
  if (moduleId === CORE_MODULE_ID) throw new Error("cannot purge the core module");
  const manifest = registry.get(moduleId);
  if (manifest === undefined) throw new Error(`module "${moduleId}" is not registered`);
  if (PROTECTED_SCHEMAS.has(manifest.schema)) throw new Error(`refusing to purge schema "${manifest.schema}" of module "${moduleId}"`);
  const schema = quoteIdentifier(manifest.schema);

  await withMigrationLock(pool, options, async (client) => {
    try {
      await client.query("begin");
      await client.query(`drop schema if exists ${schema} cascade`);
      // Before the core's first migration there is no history table, so there is nothing to delete.
      const tracked = await client.query("select to_regclass('core.schema_migrations') is not null as present");
      if (tracked.rows[0].present) {
        await client.query("delete from core.schema_migrations where module_id = $1", [manifest.id]);
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`purging module "${manifest.id}" failed: ${message}`, { cause: error });
    }
  });
}
