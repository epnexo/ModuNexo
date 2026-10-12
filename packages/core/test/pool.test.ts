import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPool, resolveDatabaseUrl } from "../src/pool.ts";

describe("resolveDatabaseUrl", () => {
  it("returns DATABASE_URL and throws a recognisable error when it is missing", () => {
    assert.equal(resolveDatabaseUrl({ DATABASE_URL: "postgres://u:p@h/db" }), "postgres://u:p@h/db");
    assert.throws(() => resolveDatabaseUrl({}), /DATABASE_URL is not set/);
  });
});

describe("createPool", () => {
  it("handles errors from idle clients instead of letting them crash the process", () => {
    const logged: unknown[][] = [];
    const pool = createPool("postgres://u:p@127.0.0.1:1/x", {}, (...args) => logged.push(args));
    assert.doesNotThrow(() => pool.emit("error", new Error("idle client lost")));
    assert.equal(logged.length, 1);
    assert.match(String(logged[0]?.[0]), /idle database client/);
  });
});
