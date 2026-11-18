import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TokenRecord } from "@modunexo/core/tokens";
import { TokenError } from "@modunexo/core/tokens";
import { type McpKeysDeps, handleCreateMcpKey, handleListMcpKeys, handleRevokeMcpKey, mcpAddCommand } from "../src/server/mcp-keys-api.ts";

const ADMIN = { actor: "admin@example.test", canWrite: true };
const USER = { actor: "user@example.test", canWrite: false };
const NOW = new Date("2026-11-18T12:00:00Z");
const DAY = 86_400_000;
const ISSUED_KEY = "mdnx_ab12cd34_THE-ONE-TIME-ISSUED_KEY-VALUE-0000000000000000000";
const record = (over: Partial<TokenRecord> = {}): TokenRecord => ({
  id: 5, moduleId: "core", name: "laptop", prefix: "ab12cd34", scopes: ["mcp.read"], createdBy: ADMIN.actor,
  createdAt: NOW, expiresAt: new Date(NOW.getTime() + 30 * DAY), revokedAt: null, lastUsedAt: null, ...over,
});

function deps(overrides: Partial<McpKeysDeps> = {}) {
  const calls = { create: [] as any[], revoke: [] as [number, string][], listed: 0 };
  const base: McpKeysDeps = {
    viewer: async () => ADMIN,
    now: () => NOW,
    service: {
      list: async () => (calls.listed++, [record(), record({ id: 6, name: "ci", scopes: ["mcp.read", "mcp.write"] })]),
      find: async (id) => (id === 5 ? record() : id === 9 ? record({ id: 9, moduleId: "inbox", scopes: ["messages.read"] }) : null),
      create: async (input) => (calls.create.push(input), { record: record({ name: input.name, expiresAt: input.expiresAt ?? null }), token: ISSUED_KEY }),
      revoke: async (id, actor) => (calls.revoke.push([id, actor]), record({ revokedAt: NOW })),
    },
  };
  return { deps: { ...base, ...overrides }, calls };
}
const same = { origin: "http://h", host: "h" };
const send = (method: string, body?: unknown, headers: Record<string, string> = same) => new Request("http://h/api/settings/mcp-keys", { method, headers, body: body === undefined ? null : JSON.stringify(body) });
const bodyOf = async (response: Response) => (await response.json()) as Record<string, any>;

describe("MCP keys: who may ask", () => {
  it("refuses cross-origin writes, visitors who are not signed in and people who are not administrators", async () => {
    const evil = { origin: "http://evil", host: "h" };
    const { deps: d, calls } = deps();
    assert.equal((await handleCreateMcpKey(send("POST", { name: "a" }, evil), d)).status, 403);
    assert.equal((await handleRevokeMcpKey(send("DELETE", undefined, evil), 5, d)).status, 403);
    for (const viewer of [async () => null, async () => USER]) {
      const other = deps({ viewer }).deps;
      const expected = (await viewer()) === null ? 401 : 403;
      assert.equal((await handleListMcpKeys(send("GET"), other)).status, expected);
      assert.equal((await handleCreateMcpKey(send("POST", { name: "a" }), other)).status, expected);
      assert.equal((await handleRevokeMcpKey(send("DELETE"), 5, other)).status, expected);
    }
    assert.deepEqual(calls.create, []);
    assert.deepEqual(calls.revoke, []);
  });
});

describe("MCP keys: list", () => {
  it("lists the core's keys with name, prefix, scopes and dates, and never a key value", async () => {
    const { deps: d } = deps();
    const response = await handleListMcpKeys(send("GET"), d);
    assert.equal(response.status, 200);
    const text = JSON.stringify(await response.json());
    assert.ok(text.includes("ab12cd34") && text.includes("mcp.write") && text.includes('"state":"active"'));
    assert.ok(!text.includes("THE-ONE-TIME-ISSUED_KEY"));
  });
});

describe("MCP keys: create", () => {
  it("issues a read key for the core that expires in 30 days when no expiry is asked, and shows the value once", async () => {
    const { deps: d, calls } = deps();
    const response = await handleCreateMcpKey(send("POST", { name: "laptop" }), d);
    assert.equal(response.status, 201);
    assert.equal((await bodyOf(response)).token, ISSUED_KEY);
    assert.deepEqual(calls.create, [{ moduleId: "core", name: "laptop", scopes: ["mcp.read"], expiresAt: new Date(NOW.getTime() + 30 * DAY), actor: ADMIN.actor }]);
  });

  it("honours an expiry from 1 to 365 days and nothing else", async () => {
    const { deps: d, calls } = deps();
    assert.equal((await handleCreateMcpKey(send("POST", { name: "a", expiresInDays: 7 }), d)).status, 201);
    assert.equal(calls.create[0].expiresAt.getTime(), NOW.getTime() + 7 * DAY);
    for (const expiresInDays of [0, -1, 366, 1.5, "30", null, Number.NaN]) {
      assert.equal((await handleCreateMcpKey(send("POST", { name: "a", expiresInDays }), d)).status, 400, String(expiresInDays));
    }
    assert.equal(calls.create.length, 1);
  });

  it("never lets the caller choose the scopes: a write key comes only from the CLI", async () => {
    const { deps: d, calls } = deps();
    for (const extra of [{ scopes: ["mcp.write"] }, { scopes: ["mcp.read"] }, { scope: "mcp.write" }, { moduleId: "inbox" }]) {
      const response = await handleCreateMcpKey(send("POST", { name: "a", ...extra }), d);
      assert.equal(response.status, 400, JSON.stringify(extra));
      assert.match((await bodyOf(response)).error, /unknown field/);
    }
    assert.deepEqual(calls.create, []);
  });

  it("refuses a missing or non-text name, a body that is not an object and a refusal of the platform", async () => {
    const { deps: d } = deps();
    for (const body of [{}, { name: 5 }, [], "x", null]) assert.equal((await handleCreateMcpKey(send("POST", body), d)).status, 400, JSON.stringify(body));
    const refusing = deps({ service: { ...deps().deps.service, create: async () => { throw new TokenError("a token needs a name", "invalid"); } } }).deps;
    const response = await handleCreateMcpKey(send("POST", { name: " " }), refusing);
    assert.equal(response.status, 400);
    assert.match((await bodyOf(response)).error, /needs a name/);
  });
});

describe("MCP keys: revoke", () => {
  it("revokes a key of the core, read or write", async () => {
    const { deps: d, calls } = deps();
    assert.equal((await handleRevokeMcpKey(send("DELETE"), 5, d)).status, 200);
    assert.deepEqual(calls.revoke, [[5, ADMIN.actor]]);
  });

  it("answers 404 for a key that does not exist and for another module's token, and never revokes it", async () => {
    const { deps: d, calls } = deps();
    for (const id of [404, 9, 0, Number.NaN, -3]) assert.equal((await handleRevokeMcpKey(send("DELETE"), id, d)).status, 404, String(id));
    assert.deepEqual(calls.revoke, []);
  });
});

describe("the command that connects Claude Code", () => {
  it("builds the add command for the address and the key, and none when there is no address", () => {
    assert.equal(
      mcpAddCommand("https://platform.example.com", ISSUED_KEY),
      `claude mcp add --transport http modunexo https://platform.example.com/svc/core/mcp --header "Authorization: Bearer ${ISSUED_KEY}"`,
    );
    assert.equal(mcpAddCommand("https://platform.example.com/", ISSUED_KEY), mcpAddCommand("https://platform.example.com", ISSUED_KEY));
    assert.equal(mcpAddCommand(null, ISSUED_KEY), null);
  });

  it("refuses to build a command out of a key or an address that could break out of the quotes", () => {
    assert.equal(mcpAddCommand("https://x.test", 'abc" ; rm -rf ~ #'), null);
    assert.equal(mcpAddCommand('https://x.test"; touch y; "', ISSUED_KEY), null);
    assert.equal(mcpAddCommand("javascript:alert(1)", ISSUED_KEY), null);
  });
});
