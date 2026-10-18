import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import { DbAccessError } from "@epnexo/sdk";
import { ModuleDbService } from "../src/data/module-db.ts";
import { migrate } from "../src/runner.ts";
import { createPool } from "../src/pool.ts";
import { createScratchDatabase } from "../src/testing.ts";
import { Sandbox } from "./sandbox.ts";

let pool: pg.Pool | undefined;
let skipReason: string | undefined;
let drop: (() => Promise<void>) | undefined;
let box: Sandbox;
let docs: string;
let notes: string;
let loner: string;
let service: ModuleDbService;

async function setState(id: string, state: "enabled" | "disabled" | "absent"): Promise<void> {
  await pool!.query("delete from core.modules where id = $1", [id]);
  if (state !== "absent") await pool!.query("insert into core.modules (id, state, installed_version) values ($1, $2, '1.0.0')", [id, state]);
}

before(async () => {
  // A database of its own: this file flips rows in core.modules, which other files count in the shared one.
  const scratch = await createScratchDatabase();
  if (scratch.url === undefined) {
    skipReason = scratch.skipReason;
    return;
  }
  drop = scratch.drop;
  pool = createPool(scratch.url);
  box = new Sandbox(pool);
  const first = box.add();
  const second = box.add({ [first.manifest.id]: "^1.0.0" });
  const third = box.add();
  for (const mod of [first, second, third]) mod.write("0001_init.sql", "create table items (id serial primary key, label text not null);");
  docs = first.manifest.id;
  notes = second.manifest.id;
  loner = third.manifest.id;
  await migrate(pool, box.registry());
  for (const id of [docs, notes, loner]) await setState(id, "enabled");
  service = new ModuleDbService(pool, box.registry(), { statementTimeoutMs: 400 });
});

after(async () => {
  if (pool) {
    await box.cleanup();
    await pool.end();
  }
  await drop?.();
});

const guard = (name: string, run: () => Promise<void>) =>
  it(name, async (t) => {
    if (!pool) return t.skip(skipReason);
    await run();
  });

describe("ModuleDbService: a module's own data", () => {
  guard("resolves unqualified names in the module's own schema and returns rows", async () => {
    const db = service.forModule(docs);
    await db.query("insert into items (label) values ($1)", ["first"]);
    const result = await db.query<{ label: string }>("select label from items");
    assert.deepEqual(result.rows, [{ label: "first" }]);
    assert.equal(result.rowCount, 1);
    const mine = await pool!.query(`select count(*)::int as n from "${box.modules[0]!.manifest.schema}".items`);
    assert.equal(mine.rows[0].n, 1);
    const theirs = await service.forModule(notes).query("select count(*)::int as n from items");
    assert.equal(theirs.rows[0]!.n, 0, "another module's table of the same name is not touched");
  });

  guard("commits a transaction whole, and rolls all of it back when the callback throws", async () => {
    const db = service.forModule(loner);
    await db.transaction(async (tx) => {
      await tx.query("insert into items (label) values ('a')");
      await tx.query("insert into items (label) values ('b')");
    });
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.query("insert into items (label) values ('c')");
        throw new Error("boom");
      }),
      /boom/,
    );
    const { rows } = await db.query<{ label: string }>("select label from items order by label");
    assert.deepEqual(rows.map((row) => row.label), ["a", "b"]);
  });

  guard("refuses a transaction handle once its transaction has ended", async () => {
    let leaked: { query: (sql: string) => Promise<unknown> } | undefined;
    await service.forModule(loner).transaction(async (tx) => {
      leaked = tx;
    });
    await assert.rejects(leaked!.query("select 1"), (error: unknown) => error instanceof DbAccessError && error.code === "closed");
  });

  guard("stops a statement that runs past the timeout", async () => {
    await assert.rejects(service.forModule(loner).query("select pg_sleep(5)"), /statement timeout/i);
  });

  guard("runs one statement per call, so SQL cannot end its own transaction and carry on outside it", async () => {
    await assert.rejects(service.forModule(loner).query("commit; select 1"), /multiple commands/i);
    await assert.rejects(service.forModule(notes).reader(docs).query("commit; insert into items (label) values ('x')"), /multiple commands/i);
  });

  guard("does not carry the schema over to the next call on the same pooled connection", async () => {
    await service.forModule(docs).query("select 1");
    const search = await pool!.query("show search_path");
    assert.doesNotMatch(String(search.rows[0].search_path), new RegExp(box.modules[0]!.manifest.schema));
  });
});

describe("ModuleDbService: who gets a handle", () => {
  guard("refuses a module this build does not know", async () => {
    assert.throws(() => service.forModule("nope"), (error: unknown) => error instanceof DbAccessError && error.code === "unknown-module");
    assert.throws(() => service.forModule("core"), (error: unknown) => error instanceof DbAccessError && error.code === "unknown-module");
  });

  guard("refuses every statement of a module that is not enabled, and allows them again once it is", async () => {
    await setState(loner, "disabled");
    await assert.rejects(service.forModule(loner).query("select 1"), (error: unknown) => error instanceof DbAccessError && error.code === "not-enabled");
    await setState(loner, "absent");
    await assert.rejects(service.forModule(loner).query("select 1"), (error: unknown) => error instanceof DbAccessError && error.code === "not-enabled");
    await setState(loner, "enabled");
    assert.equal((await service.forModule(loner).query("select 1 as one")).rows[0]!.one, 1);
  });
});

describe("ModuleDbService: relating to another module", () => {
  guard("reads a declared dependency, in that module's schema", async () => {
    const seen = await service.forModule(notes).reader(docs).query<{ label: string }>("select label from items");
    assert.deepEqual(seen.rows, [{ label: "first" }], "resolves to the dependency's items, not the caller's");
  });

  guard("refuses a write through the reader, in the database", async () => {
    await assert.rejects(
      service.forModule(notes).reader(docs).query("insert into items (label) values ('x')"),
      (error: unknown) => (error as { code?: string }).code === "25006",
    );
    const { rows } = await service.forModule(docs).query("select 1 from items where label = 'x'");
    assert.equal(rows.length, 0);
  });

  guard("refuses a module that is not listed in dependsOn, naming it", async () => {
    assert.throws(
      () => service.forModule(notes).reader(loner),
      (error: unknown) => error instanceof DbAccessError && error.code === "not-a-dependency" && error.message.includes(loner),
    );
    assert.throws(() => service.forModule(docs).reader(notes), (error: unknown) => error instanceof DbAccessError && error.code === "not-a-dependency", "dependsOn is one-way");
  });

  guard("refuses the reader while the dependency is not enabled", async () => {
    await setState(docs, "disabled");
    await assert.rejects(service.forModule(notes).reader(docs).query("select 1"), (error: unknown) => error instanceof DbAccessError && error.code === "not-enabled");
    await setState(docs, "enabled");
  });
});
