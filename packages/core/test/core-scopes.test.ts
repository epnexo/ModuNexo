import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import { CORE_MODULE_ID } from "../src/core-module.ts";
import { Registry } from "../src/registry.ts";
import { migrate } from "../src/runner.ts";
import { openTestPool } from "../src/testing.ts";
import { TokenError, TokenService } from "../src/tokens/index.ts";

const registry = () => {
  const r = new Registry();
  r.registerCore();
  return r;
};

describe("the core manifest's scopes", () => {
  it("declares mcp.read and mcp.write, and nothing else", () => {
    const scopes = registry().get(CORE_MODULE_ID)?.scopes ?? [];
    assert.deepEqual(scopes.map((s) => s.key), ["mcp.read", "mcp.write"]);
    for (const s of scopes) assert.ok(s.label.length > 0);
  });

  it("does not turn the core into a module with pages or navigation", () => {
    const core = registry().get(CORE_MODULE_ID);
    assert.deepEqual(core?.nav, []);
    assert.equal(core?.pages, undefined);
  });
});

describe("issuing a key for the core module", () => {
  let pool: pg.Pool | undefined;
  let skipReason: string | undefined;
  let service: TokenService;
  before(async () => {
    ({ pool, skipReason } = await openTestPool());
    if (!pool) return;
    await migrate(pool, registry());
    service = new TokenService(pool, registry());
    await pool.query("delete from core.service_tokens where module_id = 'core'");
  });
  after(async () => {
    if (!pool) return;
    await pool.query("delete from core.service_tokens where module_id = 'core'");
    await pool.query("delete from core.service_token_events where module_id = 'core'");
    await pool.end();
  });
  const test = (name: string, run: () => Promise<void>) =>
    it(name, async (t) => {
      if (!pool) return t.skip(skipReason);
      await run();
    });

  test("creates a read key, a read+write key, and verifies each against its scope", async () => {
    const read = await service.create({ moduleId: "core", name: "laptop", scopes: ["mcp.read"], actor: "tester" });
    const write = await service.create({ moduleId: "core", name: "ci", scopes: ["mcp.read", "mcp.write"], actor: "tester" });
    assert.deepEqual((await service.verify(read.token, { moduleId: "core", scope: "mcp.read" })).ok, true);
    assert.deepEqual(await service.verify(read.token, { moduleId: "core", scope: "mcp.write" }), { ok: false, reason: "forbidden_scope" });
    assert.equal((await service.verify(write.token, { moduleId: "core", scope: "mcp.write" })).ok, true);
  });

  test("refuses a scope the core does not declare, and a key of another module on the core's route", async () => {
    await assert.rejects(() => service.create({ moduleId: "core", name: "x", scopes: ["mcp:read"], actor: "tester" }), TokenError);
    await assert.rejects(() => service.create({ moduleId: "core", name: "x", scopes: ["admin"], actor: "tester" }), TokenError);
  });
});
