import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { type TestPool, isServerUnreachable, openTestPool, resolveTestDatabaseUrl } from "../src/testing.ts";

describe("resolveTestDatabaseUrl", () => {
  it("uses TEST_DATABASE_URL when set", () => {
    const url = resolveTestDatabaseUrl({ TEST_DATABASE_URL: "postgres://u:p@h:1/custom_test", DATABASE_URL: "postgres://u:p@h:1/dev" });
    assert.equal(url, "postgres://u:p@h:1/custom_test");
  });

  it("defaults to the development database name with a _test suffix", () => {
    assert.equal(resolveTestDatabaseUrl({ DATABASE_URL: "postgres://u:p@h:1/platform" }), "postgres://u:p@h:1/platform_test");
  });

  it("returns undefined when neither variable is set", () => {
    assert.equal(resolveTestDatabaseUrl({}), undefined);
  });

  it("refuses a test database that is the development database", () => {
    assert.throws(
      () => resolveTestDatabaseUrl({ TEST_DATABASE_URL: "postgres://u:p@h:1/platform", DATABASE_URL: "postgres://u:p@h:1/platform" }),
      /must not be the development database/,
    );
  });

  it("refuses a test database whose name does not end in _test", () => {
    assert.throws(() => resolveTestDatabaseUrl({ TEST_DATABASE_URL: "postgres://u:p@h:1/prod" }), /must end with "_test"/);
  });
});

describe("isServerUnreachable", () => {
  it("recognises network-level failures and nothing else", () => {
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ECONNRESET"]) {
      assert.equal(isServerUnreachable(Object.assign(new Error("x"), { code })), true, code);
    }
    assert.equal(isServerUnreachable(new Error("timeout expired")), true);
    for (const code of ["28P01", "28000", "3D000", "42501"]) {
      assert.equal(isServerUnreachable(Object.assign(new Error("x"), { code })), false, code);
    }
    assert.equal(isServerUnreachable(new Error("boom")), false);
  });
});

describe("openTestPool", () => {
  it("fails loudly on a misconfigured test database name instead of skipping", async () => {
    await assert.rejects(openTestPool({ TEST_DATABASE_URL: "postgres://u:p@127.0.0.1:1/prod" }), /must end with "_test"/);
  });

  it("fails loudly when the test database is the development database", async () => {
    const same = "postgres://u:p@127.0.0.1:1/platform";
    await assert.rejects(openTestPool({ TEST_DATABASE_URL: same, DATABASE_URL: same }), /must not be the development database/);
  });

  it("skips with a visible reason when the server is unreachable", async () => {
    const result = await openTestPool({ TEST_DATABASE_URL: "postgres://u:p@127.0.0.1:1/x_test" });
    assert.equal(result.pool, undefined);
    assert.match(result.skipReason ?? "", /server is unreachable/);
  });

  it("skips with a visible reason when no database is configured", async () => {
    const result = await openTestPool({});
    assert.match(result.skipReason ?? "", /neither TEST_DATABASE_URL nor DATABASE_URL/);
  });

  describe("against a reachable server", () => {
    let base: TestPool;
    before(async () => {
      base = await openTestPool();
    });
    after(async () => {
      await base.pool?.end();
    });

    it("creates a missing test database on demand", async (t) => {
      if (!base.pool) return t.skip(base.skipReason);
      const url = new URL(resolveTestDatabaseUrl()!);
      const name = `epnexo_ondemand_${randomBytes(4).toString("hex")}_test`;
      url.pathname = `/${name}`;
      const created = await openTestPool({ TEST_DATABASE_URL: url.toString() });
      try {
        assert.ok(created.pool, created.skipReason);
        assert.equal((await created.pool.query("select current_database() as name")).rows[0].name, name);
      } finally {
        await created.pool?.end();
        await base.pool.query(`drop database if exists "${name}"`);
      }
    });

    it("fails, and does not skip, when the server answers but the database cannot be reached", async (t) => {
      if (!base.pool) return t.skip(base.skipReason);
      const url = new URL(resolveTestDatabaseUrl()!);
      url.username = "no_such_role";
      await assert.rejects(openTestPool({ TEST_DATABASE_URL: url.toString() }), /test database "[a-z_]+" could not be prepared/);
    });

    it("keeps the connection usable for tests", async (t) => {
      if (!base.pool) return t.skip(base.skipReason);
      assert.ok(base.pool instanceof pg.Pool);
      assert.equal((await base.pool.query("select 1 as one")).rows[0].one, 1);
    });
  });
});
