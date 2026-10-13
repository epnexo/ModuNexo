import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type pg from "pg";
import type { Registry } from "../src/registry.ts";
import { purgeModule } from "../src/purge.ts";

/** A pool whose client records every statement and fails the ones `failOn` matches. */
function recordingPool(failOn?: RegExp, historyTable = true) {
  const statements: string[] = [];
  const client = {
    query: async (sql: string) => {
      statements.push(sql.replace(/\s+/g, " ").trim());
      if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked: true }] };
      if (sql.includes("to_regclass")) return { rows: [{ present: historyTable }] };
      if (failOn?.test(sql)) throw new Error("statement failed");
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  return { pool: { connect: async () => client } as unknown as pg.Pool, statements };
}

const registryWith = (manifest: { id: string; schema: string }) => ({ get: (id: string) => (id === manifest.id ? manifest : undefined) }) as unknown as Registry;

describe("purgeModule: guards and atomicity", () => {
  it("refuses the core module before touching the database", async () => {
    const { pool, statements } = recordingPool();
    await assert.rejects(purgeModule(pool, registryWith({ id: "core", schema: "core" }), "core"), /cannot purge the core module/);
    assert.deepEqual(statements, []);
  });

  it("refuses a module the registry does not know", async () => {
    const { pool, statements } = recordingPool();
    await assert.rejects(purgeModule(pool, registryWith({ id: "a", schema: "a" }), "ghost"), /module "ghost" is not registered/);
    assert.deepEqual(statements, []);
  });

  it("refuses any schema that is reserved or not a plain identifier, whatever the registry says", async () => {
    for (const schema of ["public", "core", "information_schema", "pg_catalog", 'x"; drop schema core; --', "Mixed"]) {
      const { pool, statements } = recordingPool();
      await assert.rejects(purgeModule(pool, registryWith({ id: "a", schema }), "a"), /refusing to purge schema|invalid SQL identifier/, schema);
      assert.deepEqual(statements, [], schema);
    }
  });

  it("drops the schema and deletes its history in one transaction under the lock", async () => {
    const { pool, statements } = recordingPool();
    await purgeModule(pool, registryWith({ id: "a-b", schema: "a_b" }), "a-b");
    const body = statements.filter((s) => !s.includes("advisory"));
    assert.deepEqual(body, [
      "begin",
      'drop schema if exists "a_b" cascade',
      "select to_regclass('core.schema_migrations') is not null as present",
      "delete from core.schema_migrations where module_id = $1",
      "select to_regclass('core.module_settings') is not null as present",
      "delete from core.module_settings where module_id = $1",
      "select to_regclass('core.platform_settings') is not null as present",
      "delete from core.platform_settings where starts_with(key, $1)",
      "commit",
    ]);
    assert.ok(statements.some((s) => s.includes("pg_try_advisory_lock")));
  });

  it("only drops the schema when the history and settings tables do not exist yet", async () => {
    const { pool, statements } = recordingPool(undefined, false);
    await purgeModule(pool, registryWith({ id: "a", schema: "a" }), "a");
    const body = statements.filter((s) => !s.includes("advisory"));
    assert.deepEqual(body, [
      "begin",
      'drop schema if exists "a" cascade',
      "select to_regclass('core.schema_migrations') is not null as present",
      "select to_regclass('core.module_settings') is not null as present",
      "select to_regclass('core.platform_settings') is not null as present",
      "commit",
    ]);
  });

  it("rolls everything back and surfaces the error when a step fails", async () => {
    const { pool, statements } = recordingPool(/delete from core\.schema_migrations/);
    await assert.rejects(purgeModule(pool, registryWith({ id: "a", schema: "a" }), "a"), /purging module "a" failed: statement failed/);
    assert.ok(statements.includes("rollback"));
    assert.ok(!statements.includes("commit"));
  });
});
