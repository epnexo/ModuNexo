import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import type pg from "pg";
import { GroupError, GroupService } from "../src/groups/service.ts";
import { readStates, upsertState } from "../src/lifecycle/store.ts";
import { Registry } from "../src/registry.ts";
import { migrate } from "../src/runner.ts";
import { openTestPool } from "../src/testing.ts";

let pool: pg.Pool | undefined;
let skipReason: string | undefined;
const modules: string[] = [];

before(async () => {
  ({ pool, skipReason } = await openTestPool());
  if (pool) {
    const registry = new Registry();
    registry.registerCore();
    await migrate(pool, registry);
  }
});

beforeEach(async () => {
  if (pool) await pool.query("delete from core.module_groups");
});

after(async () => {
  if (pool) {
    await pool.query("delete from core.modules where id = any($1)", [modules]);
    await pool.query("delete from core.module_groups");
    await pool.end();
  }
});

const test = (name: string, run: (service: GroupService) => Promise<void>) =>
  it(name, async (t) => {
    if (!pool) return t.skip(skipReason);
    await run(new GroupService(pool));
  });

const install = async (): Promise<string> => {
  const id = `g-${randomBytes(4).toString("hex")}`;
  modules.push(id);
  await upsertState(pool!, { id, state: "enabled", installedVersion: "1.0.0" });
  return id;
};
const rejectsWith = (promise: Promise<unknown>, code: GroupError["code"]) =>
  assert.rejects(promise, (error: unknown) => error instanceof GroupError && error.code === code);

describe("core.module_groups (migration 0014)", () => {
  test("leaves an installed module with no group and its state untouched", async () => {
    const id = await install();
    const { rows } = await pool!.query("select group_id, state, installed_version from core.modules where id = $1", [id]);
    assert.deepEqual(rows, [{ group_id: null, state: "enabled", installed_version: "1.0.0" }]);
  });

  test("keeps the group of a module when its state is written again", async (service) => {
    const id = await install();
    const group = await service.create("Sales");
    await service.assign(id, group.id);
    await upsertState(pool!, { id, state: "disabled", installedVersion: "1.1.0" });
    assert.equal((await service.overview()).assignments[id], group.id);
    assert.equal((await readStates(pool!)).get(id)?.installedVersion, "1.1.0");
  });
});

describe("GroupService: create, rename, reorder, delete", () => {
  test("creates groups in order, trimming the name", async (service) => {
    const first = await service.create("  Sales ");
    const second = await service.create("Support");
    assert.equal(first.name, "Sales");
    assert.deepEqual((await service.list()).map((g) => [g.name, g.position]), [["Sales", 0], ["Support", 1]]);
    assert.ok(second.id > first.id);
  });

  test("refuses an empty name, a name over 40 characters and a duplicate ignoring case", async (service) => {
    await service.create("Sales");
    await rejectsWith(service.create("   "), "invalid-name");
    await rejectsWith(service.create("x".repeat(41)), "invalid-name");
    await rejectsWith(service.create("sALES"), "duplicate");
    assert.equal((await service.list()).length, 1);
  });

  test("renames a group, and refuses a name another group has or a group that is not there", async (service) => {
    const sales = await service.create("Sales");
    await service.create("Support");
    assert.equal((await service.rename(sales.id, "Revenue")).name, "Revenue");
    await rejectsWith(service.rename(sales.id, "support"), "duplicate");
    await rejectsWith(service.rename(sales.id, ""), "invalid-name");
    await rejectsWith(service.rename(999_999_999, "Nope"), "not-found");
    assert.equal((await service.rename(sales.id, "REVENUE")).name, "REVENUE", "the same name in another case is allowed for the group that holds it");
  });

  test("moves a group to a position and keeps the positions contiguous", async (service) => {
    const a = await service.create("A");
    await service.create("B");
    const c = await service.create("C");
    await service.move(c.id, 0);
    assert.deepEqual((await service.list()).map((g) => [g.name, g.position]), [["C", 0], ["A", 1], ["B", 2]]);
    await service.move(c.id, 99);
    assert.deepEqual((await service.list()).map((g) => [g.name, g.position]), [["A", 0], ["B", 1], ["C", 2]]);
    await service.move(a.id, -5);
    assert.deepEqual((await service.list()).map((g) => g.name), ["A", "B", "C"]);
    await rejectsWith(service.move(999_999_999, 0), "not-found");
  });

  test("deletes a group, leaves its modules installed and ungrouped, and closes the gap", async (service) => {
    const id = await install();
    const a = await service.create("A");
    await service.create("B");
    await service.assign(id, a.id);
    await service.remove(a.id);
    assert.deepEqual((await service.list()).map((g) => [g.name, g.position]), [["B", 0]]);
    const { rows } = await pool!.query("select group_id, state from core.modules where id = $1", [id]);
    assert.deepEqual(rows, [{ group_id: null, state: "enabled" }]);
    await rejectsWith(service.remove(a.id), "not-found");
  });
});

describe("GroupService: assigning modules", () => {
  test("assigns, moves and clears a module's group, and counts what each group holds", async (service) => {
    const one = await install();
    const two = await install();
    const a = await service.create("A");
    const b = await service.create("B");
    await service.assign(one, a.id);
    await service.assign(two, a.id);
    let overview = await service.overview();
    assert.equal(overview.assignments[one], a.id);
    assert.deepEqual(overview.groups.map((g) => [g.name, g.moduleCount]), [["A", 2], ["B", 0]]);
    await service.assign(two, b.id);
    await service.assign(one, null);
    overview = await service.overview();
    assert.equal(overview.assignments[one], undefined);
    assert.equal(overview.assignments[two], b.id);
    assert.deepEqual(overview.groups.map((g) => g.moduleCount), [0, 1]);
  });

  test("refuses a group that is not there and a module that is not installed", async (service) => {
    const id = await install();
    const group = await service.create("A");
    await rejectsWith(service.assign(id, 999_999_999), "not-found");
    await rejectsWith(service.assign("never-installed", group.id), "module-not-installed");
    await rejectsWith(service.assign("never-installed", null), "module-not-installed");
  });

  test("two creations at the same moment get different positions", async (service) => {
    await Promise.all(["A", "B", "C", "D"].map((name) => service.create(name)));
    assert.deepEqual((await service.list()).map((g) => g.position), [0, 1, 2, 3]);
  });
});
