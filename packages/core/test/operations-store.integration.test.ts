import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import type pg from "pg";
import { OperationBusyError, finishOperation, listOperations, setStep, startOperation } from "../src/operations/index.ts";
import { Registry } from "../src/registry.ts";
import { migrate } from "../src/runner.ts";
import { openTestPool } from "../src/testing.ts";

let pool: pg.Pool | undefined;
let skipReason: string | undefined;
const SHA = "a".repeat(64);
const ACTOR = "ops-test";

before(async () => {
  ({ pool, skipReason } = await openTestPool());
  if (pool) {
    const registry = new Registry();
    registry.registerCore();
    await migrate(pool, registry);
  }
});
after(async () => {
  if (pool) {
    await pool.query("delete from core.module_operations where actor = $1", [ACTOR]);
    await pool.end();
  }
});
beforeEach(async () => {
  if (pool) await pool.query("delete from core.module_operations where actor = $1", [ACTOR]);
});

const test = (name: string, run: () => Promise<void>) =>
  it(name, async (t) => {
    if (!pool) return t.skip(skipReason);
    await run();
  });

const start = (extra: { version?: string; pid?: number } = {}) =>
  startOperation(pool!, { moduleId: "reports", version: extra.version ?? "1.0.0", sha256: SHA, kind: "install", actor: ACTOR, ...(extra.pid === undefined ? {} : { pid: extra.pid }) });

describe("module operations", () => {
  test("a run is recorded as running at its first step, then moves and finishes", async () => {
    const id = await start();
    let [row] = await listOperations(pool!, { moduleId: "reports", limit: 1 });
    assert.deepEqual({ id: row!.id, status: row!.status, step: row!.step, kind: row!.kind, actor: row!.actor, version: row!.version, finishedAt: row!.finishedAt }, { id, status: "running", step: "start", kind: "install", actor: ACTOR, version: "1.0.0", finishedAt: null });
    await setStep(pool!, id, "build", "next build");
    [row] = await listOperations(pool!, { moduleId: "reports", limit: 1 });
    assert.equal(row!.step, "build");
    assert.equal(row!.detail, "next build");
    await finishOperation(pool!, id, "succeeded");
    [row] = await listOperations(pool!, { moduleId: "reports", limit: 1 });
    assert.equal(row!.status, "succeeded");
    assert.ok(row!.finishedAt instanceof Date);
  });

  test("only one run at a time: a second start is refused while one is running", async () => {
    const first = await start();
    await assert.rejects(start({ version: "1.0.1" }), OperationBusyError);
    await finishOperation(pool!, first, "failed", "boom");
    const second = await start({ version: "1.0.1" });
    assert.ok(second > first);
    await finishOperation(pool!, second, "succeeded");
  });

  test("a run whose process is gone is marked failed as interrupted and no longer blocks", async () => {
    const dead = await start({ pid: 2 ** 22 + 12345 });
    const next = await start({ version: "1.0.1" });
    const rows = await listOperations(pool!, { moduleId: "reports", limit: 5 });
    const old = rows.find((row) => row.id === dead)!;
    assert.equal(old.status, "failed");
    assert.match(old.detail ?? "", /interrupted/);
    await finishOperation(pool!, next, "succeeded");
  });

  test("a finished run cannot be moved or finished again", async () => {
    const id = await start();
    await finishOperation(pool!, id, "rolled_back", "restored");
    await assert.rejects(finishOperation(pool!, id, "succeeded"), /not running/);
    await assert.rejects(setStep(pool!, id, "build"), /not running/);
  });

  test("lists newest first and can be filtered by module", async () => {
    const a = await start();
    await finishOperation(pool!, a, "succeeded");
    const b = await startOperation(pool!, { moduleId: "other", version: "2.0.0", sha256: SHA, kind: "upgrade", actor: ACTOR });
    await finishOperation(pool!, b, "failed", "x");
    assert.deepEqual((await listOperations(pool!, { limit: 10 })).filter((row) => row.actor === ACTOR).map((row) => row.id), [b, a]);
    assert.deepEqual((await listOperations(pool!, { moduleId: "reports", limit: 10 })).filter((row) => row.actor === ACTOR).map((row) => row.id), [a]);
  });

  test("a SHA-256 that is not 64 hex characters is refused", async () => {
    await assert.rejects(startOperation(pool!, { moduleId: "reports", version: "1.0.0", sha256: "nope", kind: "install", actor: ACTOR }));
  });
});
