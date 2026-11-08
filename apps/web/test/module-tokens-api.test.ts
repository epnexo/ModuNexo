import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TokenError, type TokenRecord } from "@modunexo/core/tokens";
import { SettingValueError } from "@modunexo/core/settings";
import { type ApiAccessDeps, parseTokenId, handleCreateToken, handleListTokens, handleRegenerateToken, handleRevokeToken, handleSetAddress } from "../src/server/module-tokens-api.ts";

const ADMIN = { actor: "admin@example.test", canWrite: true };
const USER = { actor: "user@example.test", canWrite: false };
const NOW = new Date("2026-11-08T12:00:00Z");
const record = (over: Partial<TokenRecord> = {}): TokenRecord => ({
  id: 5, moduleId: "crm", name: "laptop of Ana", prefix: "ab12cd34", scopes: ["crm.read"], createdBy: ADMIN.actor,
  createdAt: NOW, expiresAt: null, revokedAt: null, lastUsedAt: null, ...over,
});
const SECRET = "mdnx_ab12cd34_THE-ONE-TIME-SECRET-VALUE-0000000000000000000";

interface Calls { create: unknown[]; regenerate: [number, string][]; revoke: [number, string][]; setAddress: [string, string][]; unsetAddress: string[] }
function deps(overrides: Partial<ApiAccessDeps> = {}): { deps: ApiAccessDeps; calls: Calls } {
  const calls: Calls = { create: [], regenerate: [], revoke: [], setAddress: [], unsetAddress: [] };
  const base: ApiAccessDeps = {
    viewer: async () => ADMIN,
    now: () => NOW,
    service: {
      moduleIsEnabled: async (id) => id === "crm",
      list: async () => [record()],
      find: async (id) => (id === 5 ? record() : id === 9 ? record({ id: 9, moduleId: "other" }) : null),
      create: async (input) => (calls.create.push(input), { record: record({ name: input.name }), token: SECRET }),
      regenerate: async (id, actor) => (calls.regenerate.push([id, actor]), { record: record({ id: 6 }), token: SECRET, revoked: record({ revokedAt: NOW }) }),
      revoke: async (id, actor) => (calls.revoke.push([id, actor]), record({ revokedAt: NOW })),
      setAddress: async (raw, actor) => (calls.setAddress.push([raw, actor]), raw.replace(/\/.*$/, "")),
      unsetAddress: async (actor) => void calls.unsetAddress.push(actor),
    },
  };
  return { deps: { ...base, ...overrides }, calls };
}
const same = { origin: "http://h", host: "h" };
const send = (method: string, body?: unknown, headers: Record<string, string> = same) =>
  new Request("http://h/api/x", { method, headers, body: body === undefined ? null : JSON.stringify(body) });
const bodyOf = async (response: Response) => (await response.json()) as Record<string, any>;

describe("API access: who may ask", () => {
  it("refuses cross-origin writes, visitors who are not signed in and people who are not administrators", async () => {
    const { deps: d, calls } = deps();
    const evil = { origin: "http://evil", host: "h" };
    assert.equal((await handleCreateToken(send("POST", { name: "a", scopes: ["crm.read"] }, evil), "crm", d)).status, 403);
    assert.equal((await handleRevokeToken(send("DELETE", undefined, evil), "crm", 5, d)).status, 403);
    assert.equal((await handleRegenerateToken(send("POST", undefined, evil), "crm", 5, d)).status, 403);
    assert.equal((await handleSetAddress(send("PUT", { address: "https://a.test" }, evil), d)).status, 403);
    for (const viewer of [async () => null, async () => USER]) {
      const other = deps({ viewer }).deps;
      const expected = (await viewer()) === null ? 401 : 403;
      assert.equal((await handleListTokens(send("GET"), "crm", other)).status, expected);
      assert.equal((await handleCreateToken(send("POST", { name: "a", scopes: ["crm.read"] }), "crm", other)).status, expected);
      assert.equal((await handleRegenerateToken(send("POST"), "crm", 5, other)).status, expected);
      assert.equal((await handleRevokeToken(send("DELETE"), "crm", 5, other)).status, expected);
      assert.equal((await handleSetAddress(send("PUT", { address: "https://a.test" }), other)).status, expected);
    }
    assert.deepEqual([calls.create, calls.regenerate, calls.revoke, calls.setAddress], [[], [], [], []]);
  });

  it("answers 404 for a module that is not enabled", async () => {
    const { deps: d } = deps();
    assert.equal((await handleListTokens(send("GET"), "nope", d)).status, 404);
    assert.equal((await handleCreateToken(send("POST", { name: "a", scopes: ["x"] }), "nope", d)).status, 404);
  });
});

describe("API access: tokens", () => {
  it("lists tokens without ever carrying a token value", async () => {
    const response = await handleListTokens(send("GET"), "crm", deps().deps);
    assert.equal(response.status, 200);
    const text = JSON.stringify(await response.json());
    assert.match(text, /laptop of Ana/);
    assert.doesNotMatch(text, /mdnx_[0-9a-f]{8}_\S{20}/);
    assert.doesNotMatch(text, /hash/i);
  });

  it("creates a token and returns its value in that answer only, with the admin as actor", async () => {
    const { deps: d, calls } = deps();
    const response = await handleCreateToken(send("POST", { name: "laptop of Ana", scopes: ["crm.read"], expiresInDays: 90 }), "crm", d);
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await bodyOf(response)).token, SECRET);
    assert.deepEqual(calls.create, [{ moduleId: "crm", name: "laptop of Ana", scopes: ["crm.read"], expiresAt: new Date(NOW.getTime() + 90 * 86_400_000), actor: ADMIN.actor }]);
  });

  it("refuses a body it cannot use, and a service refusal comes back as a 400 with its message", async () => {
    const { deps: d, calls } = deps();
    for (const bad of [{}, { name: 5, scopes: ["a"] }, { name: "a", scopes: "a" }, { name: "a", scopes: [1] }, { name: "a", scopes: ["a"], expiresInDays: 0 }, { name: "a", scopes: ["a"], expiresInDays: 1.5 }, { name: "a", scopes: ["a"], expiresInDays: 4000 }, { name: "a", scopes: ["a"], extra: 1 }]) {
      assert.equal((await handleCreateToken(send("POST", bad), "crm", d)).status, 400, JSON.stringify(bad));
    }
    assert.deepEqual(calls.create, []);
    const refusing = deps({ service: { ...d.service, create: async () => { throw new TokenError('module "crm" does not declare the scope "x"'); } } }).deps;
    const response = await handleCreateToken(send("POST", { name: "a", scopes: ["x"] }), "crm", refusing);
    assert.equal(response.status, 400);
    assert.match((await bodyOf(response)).error, /does not declare the scope/);
  });

  it("regenerates a token of this module, returning the new value once", async () => {
    const { deps: d, calls } = deps();
    const response = await handleRegenerateToken(send("POST"), "crm", 5, d);
    assert.equal(response.status, 200);
    const body = await bodyOf(response);
    assert.equal(body.token, SECRET);
    assert.equal(body.record.id, 6);
    assert.notEqual(body.revoked.revokedAt, null);
    assert.deepEqual(calls.regenerate, [[5, ADMIN.actor]]);
  });

  it("revokes a token without returning any value", async () => {
    const { deps: d, calls } = deps();
    const response = await handleRevokeToken(send("DELETE"), "crm", 5, d);
    assert.equal(response.status, 200);
    assert.equal((await bodyOf(response)).token, undefined);
    assert.deepEqual(calls.revoke, [[5, ADMIN.actor]]);
  });

  it("never touches a token that belongs to another module, or that does not exist", async () => {
    const { deps: d, calls } = deps();
    assert.equal((await handleRevokeToken(send("DELETE"), "crm", 9, d)).status, 404);
    assert.equal((await handleRegenerateToken(send("POST"), "crm", 9, d)).status, 404);
    assert.equal((await handleRegenerateToken(send("POST"), "crm", 123, d)).status, 404);
    for (const bad of [Number.NaN, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
      assert.equal((await handleRevokeToken(send("DELETE"), "crm", bad, d)).status, 404, String(bad));
    }
    assert.deepEqual([calls.revoke, calls.regenerate], [[], []]);
  });

  it("answers 409 when the token is already revoked", async () => {
    const { deps: d } = deps();
    const refusing = deps({ service: { ...d.service, regenerate: async () => { throw new TokenError("token 5 is already revoked; issue a new one", "revoked"); } } }).deps;
    assert.equal((await handleRegenerateToken(send("POST"), "crm", 5, refusing)).status, 409);
  });
});

describe("parseTokenId", () => {
  it("takes digits only", () => {
    assert.equal(parseTokenId("42"), 42);
    for (const bad of ["", "0", "01", "-1", "1e0", "0x1", "1.5", " 1", "abc", "9".repeat(17)]) assert.ok(Number.isNaN(parseTokenId(bad)), bad);
  });
});

describe("API access: address", () => {
  it("saves the address the service normalizes, and clears it with null", async () => {
    const { deps: d, calls } = deps();
    const saved = await handleSetAddress(send("PUT", { address: "https://a.test/settings" }), d);
    assert.equal(saved.status, 200);
    assert.deepEqual(calls.setAddress, [["https://a.test/settings", ADMIN.actor]]);
    assert.equal((await bodyOf(saved)).address, "https:");
    const cleared = await handleSetAddress(send("PUT", { address: null }), d);
    assert.equal(cleared.status, 200);
    assert.deepEqual(calls.unsetAddress, [ADMIN.actor]);
  });

  it("refuses a body without address and an address the service refuses", async () => {
    const { deps: d } = deps();
    assert.equal((await handleSetAddress(send("PUT", {}), d)).status, 400);
    assert.equal((await handleSetAddress(send("PUT", { address: 5 }), d)).status, 400);
    assert.equal((await handleSetAddress(send("PUT", { address: "https://a.test", extra: 1 }), d)).status, 400);
    const refusing = deps({ service: { ...d.service, setAddress: async () => { throw new SettingValueError("the address must start with http:// or https://"); } } }).deps;
    const response = await handleSetAddress(send("PUT", { address: "ftp://x" }), refusing);
    assert.equal(response.status, 400);
    assert.match((await bodyOf(response)).error, /http/);
  });
});
