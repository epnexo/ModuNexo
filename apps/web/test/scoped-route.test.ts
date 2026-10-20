import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CLIENT_IP_HEADER } from "@modunexo/core/auth";
import type { VerifyResult } from "@modunexo/core/tokens";
import { type ScopedRouteRule, createScopedRoute } from "../src/server/scoped-route.ts";

const rule: ScopedRouteRule = { moduleId: "inbox", path: "/svc/inbox/messages", scope: "messages.read" };
const GOOD = `mdnx_${"0123abcd"}_${"A".repeat(43)}`;
const URL_ = "http://localhost/svc/inbox/messages";

interface Seen {
  token: string;
  need: { moduleId: string; scope: string };
}

function harness(answer: (token: string) => VerifyResult | Error = () => ({ ok: true, tokenId: 7 })) {
  const verified: Seen[] = [];
  const calls: Request[] = [];
  const warnings: string[] = [];
  const clock = { now: 1_700_000_000_000 };
  const scopedRoute = createScopedRoute({
    verify: async (token, need) => {
      verified.push({ token, need });
      const result = answer(token);
      if (result instanceof Error) throw result;
      return result;
    },
    now: () => clock.now,
    warn: (reason) => warnings.push(reason),
  });
  const route = scopedRoute(rule, async (request) => {
    calls.push(request);
    return new Response(`ok:${request.method}:${await request.text()}`);
  });
  return { route, verified, calls, warnings, clock, scopedRoute };
}

const send = (route: (request: Request) => Promise<Response>, headers: Record<string, string> = {}, ip = "203.0.113.5", method = "GET", body?: string) =>
  route(new Request(URL_, { method, headers: { [CLIENT_IP_HEADER]: ip, ...headers }, ...(body === undefined ? {} : { body }) }));

describe("scopedRoute: the token", () => {
  it("calls the handler with the untouched request when the token verifies for this module and scope", async () => {
    const h = harness();
    const res = await send(h.route, { authorization: `Bearer ${GOOD}` }, "203.0.113.5", "POST", "payload");
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok:POST:payload", "the body reaches the module unread");
    assert.deepEqual(h.verified, [{ token: GOOD, need: { moduleId: "inbox", scope: "messages.read" } }]);
    assert.equal(h.calls.length, 1);
  });

  it("accepts the scheme in any case and refuses other schemes and malformed headers", async () => {
    const h = harness();
    assert.equal((await send(h.route, { authorization: `bearer ${GOOD}` })).status, 200);
    for (const authorization of ["", "Bearer", "Bearer ", `Basic ${GOOD}`, GOOD, `Bearer ${GOOD} extra`, `Token ${GOOD}`]) {
      const res = await send(h.route, { authorization });
      assert.equal(res.status, 401, JSON.stringify(authorization));
    }
    assert.equal((await send(h.route)).status, 401, "no header at all");
    assert.equal(h.calls.length, 1, "only the good one reached the handler");
  });

  it("answers 401 with the same plain body and a challenge for every kind of refusal", async () => {
    const bodies = new Set<string>();
    for (const reason of ["malformed", "unknown", "revoked", "expired", "wrong_module"] as const) {
      const h = harness(() => ({ ok: false, reason }));
      const res = await send(h.route, { authorization: `Bearer ${GOOD}` });
      assert.equal(res.status, 401, reason);
      assert.equal(res.headers.get("www-authenticate"), "Bearer");
      assert.equal(res.headers.get("cache-control"), "no-store");
      bodies.add(await res.text());
      assert.equal(h.calls.length, 0, reason);
      assert.ok(h.warnings.some((w) => w.includes(reason)), `the log says ${reason}`);
    }
    assert.deepEqual([...bodies], ["Unauthorized"]);
  });

  it("answers 403 to a valid token that lacks the scope, and never calls the handler", async () => {
    const h = harness(() => ({ ok: false, reason: "forbidden_scope" }));
    const res = await send(h.route, { authorization: `Bearer ${GOOD}` });
    assert.equal(res.status, 403);
    assert.equal(await res.text(), "Forbidden");
    assert.equal(h.calls.length, 0);
  });

  it("answers 503 when the token cannot be checked, and never lets the request through", async () => {
    const h = harness(() => new Error("connection refused"));
    const res = await send(h.route, { authorization: `Bearer ${GOOD}` });
    assert.equal(res.status, 503);
    assert.equal(h.calls.length, 0);
    assert.ok(h.warnings.some((w) => w.includes("connection refused")));
  });

  it("does not look a token up when there is none to look up", async () => {
    const h = harness();
    await send(h.route, {});
    await send(h.route, { authorization: "Basic abc" });
    assert.equal(h.verified.length, 0);
  });

  it("never writes the token into the log", async () => {
    const h = harness(() => ({ ok: false, reason: "unknown" }));
    await send(h.route, { authorization: `Bearer ${GOOD}` });
    assert.ok(h.warnings.length > 0);
    assert.ok(!h.warnings.join("\n").includes(GOOD));
  });
});

describe("scopedRoute: methods and limits", () => {
  it("answers 405 when the module exports no handler for the method", async () => {
    const scopedRoute = createScopedRoute({ verify: async () => ({ ok: true, tokenId: 1 }), now: () => 0, warn: () => {} });
    const res = await scopedRoute(rule, undefined)(new Request(URL_, { headers: { authorization: `Bearer ${GOOD}` } }));
    assert.equal(res.status, 405);
  });

  it("passes the route context through to the handler", async () => {
    const scopedRoute = createScopedRoute({ verify: async () => ({ ok: true, tokenId: 1 }), now: () => 0, warn: () => {} });
    let seen: unknown;
    const context = { params: Promise.resolve({ id: "9" }) };
    await scopedRoute(rule, async (_request, c) => {
      seen = c;
      return new Response("ok");
    })(new Request(URL_, { headers: { authorization: `Bearer ${GOOD}` } }), context);
    assert.equal(seen, context);
  });

  it("limits requests per client per minute before it looks a token up, and answers 429 with Retry-After", async () => {
    const h = harness();
    const statuses: number[] = [];
    for (let i = 0; i < 122; i++) statuses.push((await send(h.route, { authorization: `Bearer ${GOOD}` }, "192.0.2.1")).status);
    assert.equal(statuses.filter((s) => s === 200).length, 120);
    assert.deepEqual(statuses.slice(120), [429, 429]);
    assert.equal(h.verified.length, 120, "a limited request costs no lookup");
    const limited = await send(h.route, { authorization: `Bearer ${GOOD}` }, "192.0.2.1");
    assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  });

  it("counts clients apart, shares one bucket without an address, and forgets after the minute", async () => {
    const h = harness(() => ({ ok: false, reason: "unknown" }));
    for (let i = 0; i < 120; i++) await send(h.route, {}, "192.0.2.2");
    assert.equal((await send(h.route, {}, "192.0.2.2")).status, 429);
    assert.equal((await send(h.route, {}, "192.0.2.3")).status, 401);
    h.clock.now += 61_000;
    assert.equal((await send(h.route, {}, "192.0.2.2")).status, 401);
    for (let i = 0; i < 120; i++) await h.route(new Request(URL_));
    assert.equal((await h.route(new Request(URL_))).status, 429);
  });
});
