import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import { Registry } from "../src/registry.ts";
import { migrate } from "../src/runner.ts";
import { openTestPool } from "../src/testing.ts";
import { TokenError, TokenService, tokenState } from "../src/tokens/index.ts";
import { Sandbox } from "./sandbox.ts";

const DAY_MS = 86_400_000;
let pool: pg.Pool | undefined;
let skipReason: string | undefined;
let box: Sandbox;
let moduleId: string;
let clock = new Date("2026-10-20T12:00:00Z");
let service: TokenService;

before(async () => {
  ({ pool, skipReason } = await openTestPool());
  if (!pool) return;
  box = new Sandbox(pool);
  const mod = box.add();
  mod.manifest.scopes = [
    { key: "messages.read", label: "Read messages" },
    { key: "messages.send", label: "Send messages" },
  ];
  moduleId = mod.manifest.id;
  await migrate(pool, box.registry());
  service = new TokenService(pool, box.registry(), { now: () => clock });
});

after(async () => {
  if (pool) {
    await pool.query("delete from core.service_tokens where module_id = $1", [moduleId]);
    await pool.query("delete from core.service_token_events where module_id = $1", [moduleId]);
    await box.cleanup();
    await pool.end();
  }
});

const test = (name: string, run: () => Promise<void>) =>
  it(name, async (t) => {
    if (!pool) return t.skip(skipReason);
    clock = new Date("2026-10-20T12:00:00Z");
    await pool.query("delete from core.service_tokens where module_id = $1", [moduleId]);
    await pool.query("delete from core.service_token_events where module_id = $1", [moduleId]);
    await run();
  });

const issue = (extra: Partial<Parameters<TokenService["create"]>[0]> = {}) =>
  service.create({ moduleId, name: "laptop of Ana", scopes: ["messages.read", "messages.send"], actor: "admin@example.com", ...extra });
const events = async () =>
  (await pool!.query("select token_id::int as token_id, action, actor from core.service_token_events where module_id = $1 order by id", [moduleId])).rows;
/** The database stamps `created_at` with the real time; a test that moves the clock needs it to say the clock's time. */
const madeAtClock = (id: number) => pool!.query("update core.service_tokens set created_at = $2 where id = $1", [id, clock]);

describe("tokenState", () => {
  it("tells active, expired and revoked apart", () => {
    const now = new Date("2026-10-20T12:00:00Z");
    const base = { id: 1, moduleId: "m", name: "n", prefix: "p", scopes: ["s"], createdBy: "x", createdAt: now, lastUsedAt: null };
    assert.equal(tokenState({ ...base, expiresAt: null, revokedAt: null }, now), "active");
    assert.equal(tokenState({ ...base, expiresAt: new Date(now.getTime() + 1), revokedAt: null }, now), "active");
    assert.equal(tokenState({ ...base, expiresAt: now, revokedAt: null }, now), "expired");
    assert.equal(tokenState({ ...base, expiresAt: null, revokedAt: now }, now), "revoked");
    assert.equal(tokenState({ ...base, expiresAt: now, revokedAt: now }, now), "revoked");
  });
});

describe("find", () => {
  test("returns one token without its value, or null", async () => {
    const made = await issue();
    assert.deepEqual(await service.find(made.record.id), made.record);
    assert.equal(await service.find(2_000_000_000), null);
  });
});

describe("regenerate", () => {
  test("issues a new token with the same name and scopes and revokes the old one", async () => {
    const old = await issue();
    const next = await service.regenerate(old.record.id, "other-admin@example.com");
    assert.notEqual(next.token, old.token);
    assert.notEqual(next.record.id, old.record.id);
    assert.equal(next.record.name, "laptop of Ana");
    assert.deepEqual(next.record.scopes, ["messages.read", "messages.send"]);
    assert.equal(next.record.createdBy, "other-admin@example.com");
    assert.equal(next.revoked.id, old.record.id);
    assert.notEqual(next.revoked.revokedAt, null);
    assert.equal((await service.verify(next.token, { moduleId, scope: "messages.read" })).ok, true);
    assert.deepEqual(await service.verify(old.token, { moduleId, scope: "messages.read" }), { ok: false, reason: "revoked" });
  });

  test("records both events with the admin who regenerated", async () => {
    const old = await issue();
    const next = await service.regenerate(old.record.id, "second@example.com");
    assert.deepEqual(await events(), [
      { token_id: old.record.id, action: "created", actor: "admin@example.com" },
      { token_id: next.record.id, action: "created", actor: "second@example.com" },
      { token_id: old.record.id, action: "revoked", actor: "second@example.com" },
    ]);
  });

  test("keeps the length of life: a token that lasted 90 days gets 90 days from now", async () => {
    const old = await issue({ expiresAt: new Date(clock.getTime() + 90 * DAY_MS) });
    await madeAtClock(old.record.id);
    clock = new Date(clock.getTime() + 10 * DAY_MS);
    const next = await service.regenerate(old.record.id, "admin");
    assert.equal(next.record.expiresAt?.getTime(), clock.getTime() + 90 * DAY_MS);
  });

  test("a token without an expiry stays without one", async () => {
    const old = await issue();
    assert.equal((await service.regenerate(old.record.id, "admin")).record.expiresAt, null);
  });

  test("renews a token that already expired", async () => {
    const old = await issue({ expiresAt: new Date(clock.getTime() + 30 * DAY_MS) });
    await madeAtClock(old.record.id);
    clock = new Date(clock.getTime() + 40 * DAY_MS);
    const next = await service.regenerate(old.record.id, "admin");
    assert.equal(next.record.expiresAt?.getTime(), clock.getTime() + 30 * DAY_MS);
    assert.equal(tokenState(next.revoked, clock), "revoked");
  });

  test("refuses a token that is already revoked, and creates nothing", async () => {
    const old = await issue();
    await service.revoke(old.record.id, "admin");
    await assert.rejects(() => service.regenerate(old.record.id, "admin"), TokenError);
    assert.equal((await service.list(moduleId)).length, 1);
  });

  test("refuses a token that does not exist", async () => {
    await assert.rejects(() => service.regenerate(2_000_000_000, "admin"), /there is no token/);
  });

  test("leaves the old token working when the new one cannot be issued", async () => {
    const old = await issue();
    // The same module, but its manifest no longer declares one of the token's scopes.
    const narrowed = new Registry();
    narrowed.registerCore();
    narrowed.register({ ...box.registry().get(moduleId)!, scopes: [{ key: "messages.read", label: "Read messages" }] });
    const narrow = new TokenService(pool!, narrowed, { now: () => clock });
    await assert.rejects(() => narrow.regenerate(old.record.id, "admin"), /does not declare the scope "messages.send" any more/);
    assert.equal((await service.verify(old.token, { moduleId, scope: "messages.read" })).ok, true);
    assert.equal((await service.list(moduleId)).length, 1);
    assert.equal((await events()).length, 1);
  });
});
