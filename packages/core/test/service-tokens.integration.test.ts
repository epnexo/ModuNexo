import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import { migrate } from "../src/runner.ts";
import { openTestPool } from "../src/testing.ts";
import { TokenError, TokenService, generateToken, hashToken, tokenPrefix } from "../src/tokens/index.ts";
import { Sandbox } from "./sandbox.ts";

let pool: pg.Pool | undefined;
let skipReason: string | undefined;
let box: Sandbox;
let moduleId: string;
let otherId: string;
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
  const other = box.add();
  other.manifest.scopes = [{ key: "messages.read", label: "Read messages" }];
  otherId = other.manifest.id;
  await migrate(pool, box.registry());
  service = new TokenService(pool, box.registry(), { now: () => clock });
});

after(async () => {
  if (pool) {
    // Only this file's own modules: another file shares this database.
    await pool.query("delete from core.service_tokens where module_id = any($1)", [[moduleId, otherId]]);
    await pool.query("delete from core.service_token_events where module_id = any($1)", [[moduleId, otherId]]);
    await box.cleanup();
    await pool.end();
  }
});

const test = (name: string, run: () => Promise<void>) =>
  it(name, async (t) => {
    if (!pool) return t.skip(skipReason);
    clock = new Date("2026-10-20T12:00:00Z");
    await pool.query("delete from core.service_tokens where module_id = any($1)", [[moduleId, otherId]]);
    await pool.query("delete from core.service_token_events where module_id = any($1)", [[moduleId, otherId]]);
    await run();
  });

const issue = (extra: Partial<Parameters<TokenService["create"]>[0]> = {}) =>
  service.create({ moduleId, name: "inbox sync", scopes: ["messages.read"], actor: "tester", ...extra });
const need = (scope = "messages.read", id = moduleId) => ({ moduleId: id, scope });

describe("token format", () => {
  it("makes a token of a known shape whose prefix and hash are derived from it", () => {
    const { token, prefix, hash } = generateToken();
    assert.match(token, /^mdnx_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
    assert.equal(tokenPrefix(token), prefix);
    assert.equal(hash, hashToken(token));
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.notEqual(generateToken().token, token);
  });

  it("reads no prefix from anything that is not a token", () => {
    for (const text of ["", "mdnx_", "mdnx_zzzzzzzz_" + "a".repeat(43), "mdnx_0123abcd_" + "a".repeat(42), "mdnx_0123abcd_" + "a".repeat(44), "Bearer x", " mdnx_0123abcd_" + "a".repeat(43)]) {
      assert.equal(tokenPrefix(text), null, text);
    }
  });
});

describe("TokenService.create", () => {
  test("returns the token once and stores only its hash", async () => {
    const { record, token } = await issue();
    assert.match(token, /^mdnx_/);
    const row = (await pool!.query("select * from core.service_tokens where id = $1", [record.id])).rows[0];
    assert.equal(row.token_hash, hashToken(token));
    assert.ok(!JSON.stringify(row).includes(token), "the database never holds the token");
    assert.equal(row.prefix, tokenPrefix(token));
    assert.deepEqual(row.scopes, ["messages.read"]);
    assert.equal(row.created_by, "tester");
    assert.equal(row.revoked_at, null);
    assert.deepEqual(Object.keys(record).sort(), ["createdAt", "createdBy", "expiresAt", "id", "lastUsedAt", "moduleId", "name", "prefix", "revokedAt", "scopes"]);
  });

  test("records who created it, with no token in the trail", async () => {
    const { record, token } = await issue();
    const events = (await pool!.query("select * from core.service_token_events where token_id = $1", [record.id])).rows;
    assert.deepEqual(events.map((e) => [e.action, e.actor, e.module_id]), [["created", "tester", moduleId]]);
    assert.ok(!JSON.stringify(events).includes(token));
  });

  test("sorts and de-duplicates scopes", async () => {
    const { record } = await issue({ scopes: ["messages.send", "messages.read", "messages.send"] });
    assert.deepEqual(record.scopes, ["messages.read", "messages.send"]);
  });

  test("refuses an unknown module, an undeclared scope, no scope and a bad name", async () => {
    await assert.rejects(issue({ moduleId: "no-such-module" }), (e: unknown) => e instanceof TokenError && /not registered/.test(e.message));
    await assert.rejects(issue({ scopes: ["messages.delete"] }), (e: unknown) => e instanceof TokenError && /does not declare the scope "messages.delete"/.test(e.message));
    await assert.rejects(issue({ scopes: [] }), /at least one scope/);
    for (const name of ["", "   ", "x".repeat(81), "bad\u0000name", "line\nbreak"]) {
      await assert.rejects(issue({ name }), (e: unknown) => e instanceof TokenError, JSON.stringify(name));
    }
    assert.equal((await pool!.query("select 1 from core.service_tokens where module_id = $1", [moduleId])).rowCount, 0, "nothing was stored");
  });

  test("refuses an expiry that is not in the future", async () => {
    await assert.rejects(issue({ expiresAt: new Date(clock.getTime() - 1) }), /in the future/);
    await assert.rejects(issue({ expiresAt: new Date(clock.getTime()) }), /in the future/);
    await issue({ expiresAt: new Date(clock.getTime() + 1000) });
  });

  test("draws again when a prefix is taken", async () => {
    const first = await issue();
    const prefix = first.record.prefix;
    const draws: Buffer[] = [Buffer.from(prefix, "hex"), Buffer.alloc(32, 1), Buffer.from("0a0b0c0d", "hex"), Buffer.alloc(32, 2)];
    const forced = new TokenService(pool!, box.registry(), { now: () => clock, random: () => draws.shift() ?? Buffer.alloc(32, 9) });
    const second = await forced.create({ moduleId, name: "second", scopes: ["messages.read"], actor: "tester" });
    assert.equal(second.record.prefix, "0a0b0c0d");
  });
});

describe("TokenService.verify", () => {
  test("accepts the token for its module and scope", async () => {
    const { record, token } = await issue({ scopes: ["messages.read", "messages.send"] });
    assert.deepEqual(await service.verify(token, need("messages.read")), { ok: true, tokenId: record.id });
    assert.deepEqual(await service.verify(token, need("messages.send")), { ok: true, tokenId: record.id });
  });

  test("refuses a scope the token does not hold, and says so", async () => {
    const { token } = await issue();
    assert.deepEqual(await service.verify(token, need("messages.send")), { ok: false, reason: "forbidden_scope" });
  });

  test("refuses a token used on another module's route", async () => {
    const { token } = await issue();
    assert.deepEqual(await service.verify(token, need("messages.read", otherId)), { ok: false, reason: "wrong_module" });
  });

  test("refuses malformed text, an unknown prefix and a right prefix with a wrong secret", async () => {
    const { token } = await issue();
    assert.deepEqual(await service.verify("nope", need()), { ok: false, reason: "malformed" });
    assert.deepEqual(await service.verify("", need()), { ok: false, reason: "malformed" });
    const unknown = `mdnx_${"f".repeat(8)}_${"A".repeat(43)}`;
    assert.deepEqual(await service.verify(unknown, need()), { ok: false, reason: "unknown" });
    const forged = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    assert.deepEqual(await service.verify(forged, need()), { ok: false, reason: "unknown" });
  });

  test("refuses a revoked token at once", async () => {
    const { record, token } = await issue();
    assert.equal((await service.verify(token, need())).ok, true);
    await service.revoke(record.id, "tester");
    assert.deepEqual(await service.verify(token, need()), { ok: false, reason: "revoked" });
  });

  test("refuses an expired token and accepts it right before", async () => {
    const { token } = await issue({ expiresAt: new Date(clock.getTime() + 60_000) });
    clock = new Date(clock.getTime() + 59_999);
    assert.equal((await service.verify(token, need())).ok, true);
    clock = new Date(clock.getTime() + 1);
    assert.deepEqual(await service.verify(token, need()), { ok: false, reason: "expired" });
  });

  test("notes the last use at most once a minute", async () => {
    const { record, token } = await issue();
    const lastUsed = async () => (await pool!.query("select last_used_at from core.service_tokens where id = $1", [record.id])).rows[0].last_used_at as Date | null;
    assert.equal(await lastUsed(), null);
    await service.verify(token, need());
    assert.deepEqual(await lastUsed(), clock);
    const first = clock;
    clock = new Date(clock.getTime() + 30_000);
    await service.verify(token, need());
    assert.deepEqual(await lastUsed(), first, "inside the minute nothing is written");
    clock = new Date(clock.getTime() + 30_000);
    await service.verify(token, need());
    assert.deepEqual(await lastUsed(), clock);
  });

  test("does not note a use for a refused token", async () => {
    const { record, token } = await issue();
    await service.verify(token, need("messages.send"));
    assert.equal((await pool!.query("select last_used_at from core.service_tokens where id = $1", [record.id])).rows[0].last_used_at, null);
  });
});

describe("TokenService.list and revoke", () => {
  test("lists a module's tokens without any secret, and all tokens when no module is named", async () => {
    const a = await issue({ name: "a" });
    await service.create({ moduleId: otherId, name: "b", scopes: ["messages.read"], actor: "tester" });
    const mine = await service.list(moduleId);
    assert.deepEqual(mine.map((t) => t.name), ["a"]);
    assert.deepEqual(Object.keys(mine[0]!).sort().includes("token"), false);
    assert.ok(!JSON.stringify(mine).includes(a.token));
    assert.ok(!JSON.stringify(mine).includes(hashToken(a.token)));
    assert.deepEqual((await service.list()).filter((t) => [moduleId, otherId].includes(t.moduleId)).map((t) => t.name), ["a", "b"]);
  });

  test("revokes once, records it, and a second revoke changes nothing", async () => {
    const { record } = await issue();
    const revoked = await service.revoke(record.id, "operator");
    assert.deepEqual(revoked.revokedAt, clock);
    clock = new Date(clock.getTime() + 5000);
    const again = await service.revoke(record.id, "someone-else");
    assert.deepEqual(again.revokedAt, revoked.revokedAt, "the first revocation stands");
    const events = (await pool!.query("select action, actor from core.service_token_events where token_id = $1 order by id", [record.id])).rows;
    assert.deepEqual(events, [{ action: "created", actor: "tester" }, { action: "revoked", actor: "operator" }]);
  });

  test("refuses to revoke a token that does not exist", async () => {
    await assert.rejects(service.revoke(999_999_999, "operator"), (e: unknown) => e instanceof TokenError && /no token 999999999/.test(e.message));
  });
});
