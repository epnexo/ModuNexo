import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TokenRecord } from "@modunexo/core/tokens";
import { buildAccessView } from "../src/server/api-access-view.ts";

const NOW = new Date("2026-11-08T12:00:00Z");
const token = (over: Partial<TokenRecord>): TokenRecord => ({
  id: 1, moduleId: "crm", name: "laptop", prefix: "ab12cd34", scopes: ["crm.read"], createdBy: "admin@example.test",
  createdAt: new Date("2026-10-01T00:00:00Z"), expiresAt: null, revokedAt: null, lastUsedAt: null, ...over,
});
const manifest = {
  scopes: [{ key: "crm.read", label: "Read contacts" }, { key: "crm.write", label: "Change contacts" }],
  pages: [
    { path: "/crm", entry: "./a.tsx", kind: "page" },
    { path: "/svc/crm/contacts", entry: "./b.ts", kind: "route", scope: "crm.read" },
    { path: "/svc/crm/contacts/create", entry: "./c.ts", kind: "route", methods: ["POST"], scope: "crm.write" },
  ],
} as never;

describe("buildAccessView", () => {
  it("is null for a module with no scopes, since it has no API", () => {
    assert.equal(buildAccessView({ manifest: {} as never, tokens: [], address: { address: null, source: "none" }, now: NOW }), null);
  });

  it("gives the endpoints their full address and the scopes the form can offer", () => {
    const view = buildAccessView({ manifest, tokens: [], address: { address: "https://crm.example.test", source: "saved" }, now: NOW })!;
    assert.deepEqual(view.scopes, [{ key: "crm.read", label: "Read contacts" }, { key: "crm.write", label: "Change contacts" }]);
    assert.deepEqual(view.endpoints.map((e) => `${e.method} ${e.url}`), ["GET https://crm.example.test/svc/crm/contacts", "POST https://crm.example.test/svc/crm/contacts/create"]);
    assert.deepEqual(view.address, { value: "https://crm.example.test", source: "saved" });
  });

  it("keeps the path alone while there is no address to put in front of it", () => {
    const view = buildAccessView({ manifest, tokens: [], address: { address: null, source: "none" }, now: NOW })!;
    assert.equal(view.endpoints[0]!.url, "/svc/crm/contacts");
    assert.equal(view.address.value, null);
  });

  it("describes each token with plain dates and its state, and carries nothing secret", () => {
    const tokens = [
      token({ id: 1 }),
      token({ id: 2, name: "old", expiresAt: new Date("2026-11-01T00:00:00Z") }),
      token({ id: 3, name: "gone", revokedAt: new Date("2026-11-02T00:00:00Z"), lastUsedAt: new Date("2026-11-01T10:30:00Z") }),
    ];
    const view = buildAccessView({ manifest, tokens, address: { address: null, source: "none" }, now: NOW })!;
    assert.deepEqual(view.tokens.map((t) => [t.id, t.state]), [[1, "active"], [2, "expired"], [3, "revoked"]]);
    assert.equal(view.tokens[2]!.lastUsedAt, "2026-11-01T10:30:00.000Z");
    assert.equal(view.tokens[0]!.expiresAt, null);
    assert.deepEqual(Object.keys(view.tokens[0]!).sort(), ["createdAt", "createdBy", "expiresAt", "id", "lastUsedAt", "name", "prefix", "scopes", "state"]);
  });

  it("lists active tokens first, newest first, then the rest", () => {
    const tokens = [
      token({ id: 1, revokedAt: NOW }),
      token({ id: 2, createdAt: new Date("2026-10-01T00:00:00Z") }),
      token({ id: 3, createdAt: new Date("2026-10-05T00:00:00Z") }),
    ];
    const view = buildAccessView({ manifest, tokens, address: { address: null, source: "none" }, now: NOW })!;
    assert.deepEqual(view.tokens.map((t) => t.id), [3, 2, 1]);
  });
});
