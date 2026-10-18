import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { DB_READER, type DbReader, DbAccessError, DbUnavailableError, type ModuleDb, getDb } from "../src/db.ts";

const store = globalThis as typeof globalThis & { [DB_READER]?: DbReader };
afterEach(() => {
  delete store[DB_READER];
});

const fakeDb = (label: string): ModuleDb => ({
  query: async <Row extends Record<string, unknown>>() => ({ rows: [{ label }] as unknown as Row[], rowCount: 1 }),
  transaction: async (run) => run({ query: async () => ({ rows: [], rowCount: 0 }) }),
  reader: () => ({ query: async () => ({ rows: [], rowCount: 0 }) }),
});

describe("getDb", () => {
  it("asks the reader the platform registered, with the module id", async () => {
    const asked: string[] = [];
    store[DB_READER] = {
      forModule: (moduleId) => {
        asked.push(moduleId);
        return fakeDb(moduleId);
      },
    };
    const result = await getDb("notes").query("select 1");
    assert.deepEqual(asked, ["notes"]);
    assert.deepEqual(result.rows, [{ label: "notes" }]);
  });

  it("says plainly that data access only exists inside the platform when no reader is registered", () => {
    assert.throws(() => getDb("notes"), (error: unknown) => error instanceof DbUnavailableError && /platform/.test(error.message));
  });

  it("passes through the refusal the platform raises, keeping its code", () => {
    store[DB_READER] = {
      forModule: () => {
        throw new DbAccessError("not-enabled", 'module "notes" is not enabled');
      },
    };
    assert.throws(() => getDb("notes"), (error: unknown) => error instanceof DbAccessError && error.code === "not-enabled");
  });
});
