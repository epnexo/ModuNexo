import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type pg from "pg";
import { Registry } from "../src/registry.ts";
import { migrate } from "../src/runner.ts";

/** A pool whose only client answers every query with no rows; `lock` decides the advisory lock outcome. */
function fakePool(options: { lock?: boolean; unlockFails?: boolean } = {}) {
  const released: unknown[] = [];
  const client = {
    query: async (sql: string) => {
      if (sql.includes("pg_try_advisory_lock")) return { rows: [{ locked: options.lock ?? true }], rowCount: 1 };
      if (sql.includes("pg_advisory_unlock") && options.unlockFails) throw new Error("unlock failed: connection lost");
      return { rows: [], rowCount: 0 };
    },
    release: (arg?: unknown) => {
      released.push(arg);
    },
  };
  return { pool: { connect: async () => client } as unknown as pg.Pool, released };
}

function registryWithMissingDir(): Registry {
  const registry = new Registry();
  registry.registerCore();
  return registry;
}

describe("migrate lock handling", () => {
  it("reports the original migration error when releasing the lock also fails", async () => {
    const { pool, released } = fakePool({ unlockFails: true });
    await assert.rejects(
      migrate(pool, registryWithMissingDir(), { moduleDirs: { core: "/nonexistent/core-dir" } }),
      /migrations directory "\/nonexistent\/core-dir\/migrations" does not exist/,
    );
    assert.deepEqual(released, [true], "the suspect connection must be destroyed so its session lock is dropped");
  });

  it("gives up with a clear error when the lock is not obtained within the timeout", async () => {
    const { pool, released } = fakePool({ lock: false });
    const started = Date.now();
    await assert.rejects(
      migrate(pool, registryWithMissingDir(), { lockTimeoutMs: 150, lockPollMs: 20 }),
      /could not acquire the migration lock within 150 ms/,
    );
    assert.ok(Date.now() - started < 2000, "the wait must be bounded");
    assert.deepEqual(released, [undefined], "no lock was taken, so the connection goes back to the pool");
  });
});
