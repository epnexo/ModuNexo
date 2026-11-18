import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CLIENT_IP_HEADER } from "@modunexo/core/auth";
import type { VerifyResult } from "@modunexo/core/tokens";
import { isPublicRoute, platformPublicRoutes } from "../src/server/route-permissions.ts";
import { type ScopedRouteRule, createScopedRoute } from "../src/server/scoped-route.ts";

const MCP_RULE: ScopedRouteRule = { moduleId: "core", path: "/svc/core/mcp", scope: "mcp:read" };
const KEY = `mdnx_${"0123abcd"}_${"A".repeat(43)}`;

describe("the gate and the platform's own MCP route", () => {
  // The route belongs to the platform, not to an installed module, so it must be public even with no modules at all.
  const rules = platformPublicRoutes([]);

  it("opens /svc/core/mcp to the route's own key check, and nothing around it", () => {
    assert.equal(isPublicRoute("/svc/core/mcp", rules), true);
    assert.equal(isPublicRoute("/svc/core/mcp/", rules), true);
    for (const path of ["/svc", "/svc/core", "/svc/core/mcp/extra", "/svc/core/other", "/svc/inbox/mcp", "/svc/core/%2e%2e/settings", "/svc/core/mcp/..%2Fsettings", "/api/mcp", "/hooks/core/mcp"]) {
      assert.equal(isPublicRoute(path, rules), false, path);
    }
  });

  it("keeps the routes of installed modules next to it", () => {
    const withModule = platformPublicRoutes([{ pages: [{ path: "/svc/inbox/messages", scope: "messages.read" }] }]);
    assert.equal(isPublicRoute("/svc/inbox/messages", withModule), true);
    assert.equal(isPublicRoute("/svc/core/mcp", withModule), true);
  });
});

describe("a hand-written scoped route for the core module", () => {
  const harness = (answer: (token: string) => VerifyResult) => {
    const verified: { token: string; need: { moduleId: string; scope: string } }[] = [];
    const scopedRoute = createScopedRoute({
      verify: async (token, need) => {
        verified.push({ token, need });
        return answer(token);
      },
      now: () => 1_700_000_000_000,
      warn: () => {},
    });
    let reached = 0;
    const route = scopedRoute(MCP_RULE, async () => {
      reached += 1;
      return new Response("handled");
    });
    const call = (headers: Record<string, string> = {}) => route(new Request("http://localhost/svc/core/mcp", { method: "POST", headers: { [CLIENT_IP_HEADER]: "203.0.113.5", ...headers }, body: "{}" }));
    return { call, verified, reached: () => reached };
  };

  it("refuses a call without a key before the handler runs", async () => {
    const h = harness(() => ({ ok: true, tokenId: 1 }));
    assert.equal((await h.call()).status, 401);
    assert.equal(h.reached(), 0);
    assert.equal(h.verified.length, 0);
  });

  it("refuses a wrong, revoked, expired or another module's key", async () => {
    for (const reason of ["unknown", "revoked", "expired", "wrong_module", "malformed"] as const) {
      const h = harness(() => ({ ok: false, reason }));
      assert.equal((await h.call({ authorization: `Bearer ${KEY}` })).status, 401, reason);
      assert.equal(h.reached(), 0, reason);
    }
  });

  it("answers 403 for a key that does not hold the route's scope, and asks for the core module's scope", async () => {
    const h = harness(() => ({ ok: false, reason: "forbidden_scope" }));
    assert.equal((await h.call({ authorization: `Bearer ${KEY}` })).status, 403);
    assert.equal(h.reached(), 0);
    assert.deepEqual(h.verified[0]?.need, { moduleId: "core", scope: "mcp:read" });
  });

  it("refuses a malformed Authorization header without asking the token service", async () => {
    const h = harness(() => ({ ok: true, tokenId: 1 }));
    for (const authorization of ["Basic abc", "Bearer", `bearer ${KEY} extra`, KEY]) {
      assert.equal((await h.call({ authorization })).status, 401, authorization);
    }
    assert.equal(h.reached(), 0);
  });

  it("lets a valid key through to the handler", async () => {
    const h = harness(() => ({ ok: true, tokenId: 1 }));
    const response = await h.call({ authorization: `Bearer ${KEY}` });
    assert.equal(response.status, 200);
    assert.equal(h.reached(), 1);
  });
});
