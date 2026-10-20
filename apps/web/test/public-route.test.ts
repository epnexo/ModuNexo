import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { CLIENT_IP_HEADER } from "@modunexo/core/auth";
import { type PublicRouteRule, createPublicRoute } from "../src/server/public-route.ts";

const SECRET = "s3cret-value";
const URL_ = "http://localhost/hooks/inbox/messages";
const rule = (extra: Partial<PublicRouteRule> = {}, signature: Partial<PublicRouteRule["signature"]> = {}): PublicRouteRule => ({
  moduleId: "inbox",
  path: "/hooks/inbox/messages",
  signature: { secret: "webhook_secret", header: "x-signature", ...signature },
  ...extra,
});

const hmac = (text: string | Buffer, encoding: "hex" | "base64" = "hex", secret = SECRET) => createHmac("sha256", secret).update(text).digest(encoding);

interface Harness {
  calls: Request[];
  route: (r: PublicRouteRule, handler?: (request: Request) => Response | Promise<Response>) => (request: Request) => Promise<Response>;
  clock: { now: number };
  warnings: string[];
}

function harness(secret: string | null | Error = SECRET): Harness {
  const calls: Request[] = [];
  const clock = { now: 1_700_000_000_000 };
  const warnings: string[] = [];
  const publicRoute = createPublicRoute({
    getSecret: async () => {
      if (secret instanceof Error) throw secret;
      return secret;
    },
    now: () => clock.now,
    warn: (reason) => warnings.push(reason),
  });
  return {
    calls,
    clock,
    warnings,
    route: (r, handler) =>
      publicRoute(
        r,
        handler ??
          (async (request) => {
            calls.push(request);
            return new Response(`ok:${await request.text()}`, { status: 200 });
          }),
      ),
  };
}

const send = (route: (request: Request) => Promise<Response>, body: string, headers: Record<string, string> = {}, ip = "203.0.113.5", method = "POST") =>
  route(new Request(URL_, { method, body, headers: { [CLIENT_IP_HEADER]: ip, ...headers } }));

describe("publicRoute: signature", () => {
  it("calls the handler with the same body when the signature matches", async () => {
    const h = harness();
    const res = await send(h.route(rule()), '{"a":1}', { "x-signature": hmac('{"a":1}') });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ok:{"a":1}');
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0]!.method, "POST");
  });

  it("refuses a wrong signature without calling the handler", async () => {
    const h = harness();
    const res = await send(h.route(rule()), "body", { "x-signature": hmac("other body") });
    assert.equal(res.status, 401);
    assert.equal(h.calls.length, 0);
  });

  it("refuses a missing header, an empty one and one in the wrong format", async () => {
    const h = harness();
    const cases: Record<string, string>[] = [{}, { "x-signature": "" },{ "x-signature": "not-hex" }, { "x-signature": hmac("body").slice(0, 10) }, { "x-signature": `${hmac("body")}00` }];
    for (const headers of cases) {
      assert.equal((await send(h.route(rule()), "body", headers)).status, 401, JSON.stringify(headers));
    }
    assert.equal(h.calls.length, 0);
  });

  it("gives every refusal the same plain answer, so it says nothing about why", async () => {
    const h = harness();
    const a = await send(h.route(rule()), "body", {});
    const b = await send(h.route(rule()), "body", { "x-signature": hmac("nope") });
    assert.equal(await a.text(), await b.text());
    assert.equal(a.headers.get("cache-control"), "no-store");
  });

  it("fails closed when the secret is not set, empty or unreadable", async () => {
    for (const secret of [null, "", new Error("settings unavailable")]) {
      const h = harness(secret);
      const res = await send(h.route(rule()), "body", { "x-signature": hmac("body", "hex", "") });
      assert.equal(res.status, 401, String(secret));
      assert.equal(h.calls.length, 0);
    }
  });

  it("does not accept a signature made with another secret", async () => {
    const h = harness();
    assert.equal((await send(h.route(rule()), "body", { "x-signature": hmac("body", "hex", "other") })).status, 401);
  });

  it("supports base64 and a prefix", async () => {
    const h = harness();
    const r = rule({}, { encoding: "base64", prefix: "sha256=" });
    assert.equal((await send(h.route(r), "body", { "x-signature": `sha256=${hmac("body", "base64")}` })).status, 200);
    assert.equal((await send(h.route(r), "body", { "x-signature": hmac("body", "base64") })).status, 401, "the prefix is required");
    assert.equal((await send(h.route(r), "body", { "x-signature": `sha1=${hmac("body", "base64")}` })).status, 401);
  });

  it("accepts an uppercase hex digest", async () => {
    const h = harness();
    assert.equal((await send(h.route(rule()), "body", { "x-signature": hmac("body").toUpperCase() })).status, 200);
  });

  it("signs the raw bytes, not a re-encoded string", async () => {
    const h = harness();
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x41]);
    const res = await h.route(rule())(new Request(URL_, { method: "POST", body: bytes, headers: { [CLIENT_IP_HEADER]: "198.51.100.1", "x-signature": hmac(bytes) } }));
    assert.equal(res.status, 200);
  });

  it("verifies PUT, PATCH and DELETE the same way", async () => {
    const h = harness();
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      assert.equal((await send(h.route(rule()), "x", { "x-signature": hmac("x") }, "198.51.100.2", method)).status, 200, method);
      assert.equal((await send(h.route(rule()), "x", {}, "198.51.100.2", method)).status, 401, method);
    }
  });

  it("answers 405 when the module exports no handler for the method", async () => {
    const publicRoute = createPublicRoute({ getSecret: async () => SECRET, now: () => 0, warn: () => {} });
    const res = await publicRoute(rule(), undefined)(new Request(URL_, { method: "POST", body: "x", headers: { "x-signature": hmac("x") } }));
    assert.equal(res.status, 405);
  });

  it("passes the route context through to the handler", async () => {
    const publicRoute = createPublicRoute({ getSecret: async () => SECRET, now: () => 0, warn: () => {} });
    let seen: unknown;
    const route = publicRoute(rule(), async (_request, context) => {
      seen = context;
      return new Response("ok");
    });
    const context = { params: Promise.resolve({ channel: "whatsapp" }) };
    await route(new Request(URL_, { method: "POST", body: "x", headers: { "x-signature": hmac("x") } }), context);
    assert.equal(seen, context);
  });
});

describe("publicRoute: replay window", () => {
  const timed = rule({}, { timestampHeader: "x-timestamp", toleranceSeconds: 60 });
  const stamp = (h: Harness, offsetSeconds = 0) => String(Math.floor(h.clock.now / 1000) + offsetSeconds);

  it("signs `<timestamp>.<body>` and accepts a fresh request", async () => {
    const h = harness();
    const t = stamp(h);
    const res = await send(h.route(timed), "body", { "x-timestamp": t, "x-signature": hmac(`${t}.body`) });
    assert.equal(res.status, 200);
  });

  it("refuses a signature of the body alone when a timestamp is declared", async () => {
    const h = harness();
    const t = stamp(h);
    assert.equal((await send(h.route(timed), "body", { "x-timestamp": t, "x-signature": hmac("body") })).status, 401);
  });

  it("refuses a stale request and one from the future, and accepts the edge of the window", async () => {
    const h = harness();
    for (const [offset, status] of [[-61, 401], [61, 401], [-60, 200], [60, 200]] as const) {
      const t = stamp(h, offset);
      assert.equal((await send(h.route(timed), "body", { "x-timestamp": t, "x-signature": hmac(`${t}.body`) })).status, status, String(offset));
    }
  });

  it("refuses a missing or malformed timestamp", async () => {
    const h = harness();
    for (const t of [undefined, "", "abc", "1.5", "-1", "1e9", " 1700000000"]) {
      const headers: Record<string, string> = { "x-signature": hmac(`${t ?? ""}.body`) };
      if (t !== undefined) headers["x-timestamp"] = t;
      assert.equal((await send(h.route(timed), "body", headers)).status, 401, String(t));
    }
  });

  it("uses 300 seconds when no tolerance is declared", async () => {
    const h = harness();
    const r = rule({}, { timestampHeader: "x-timestamp" });
    const ok = stamp(h, -300);
    const old = stamp(h, -301);
    assert.equal((await send(h.route(r), "b", { "x-timestamp": ok, "x-signature": hmac(`${ok}.b`) })).status, 200);
    assert.equal((await send(h.route(r), "b", { "x-timestamp": old, "x-signature": hmac(`${old}.b`) })).status, 401);
  });
});

describe("publicRoute: limits", () => {
  it("answers 413 above the body limit, by header and by actual size, before the handler", async () => {
    const h = harness();
    const r = rule({ maxBodyBytes: 10 });
    const big = "x".repeat(11);
    const res = await send(h.route(r), big, { "x-signature": hmac(big) });
    assert.equal(res.status, 413);
    const stream = new Request(URL_, {
      method: "POST",
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("x".repeat(6)));
          controller.enqueue(new TextEncoder().encode("x".repeat(6)));
          controller.close();
        },
      }),
      headers: { [CLIENT_IP_HEADER]: "198.51.100.9" },
      // @ts-expect-error duplex is required by Node for a streamed body
      duplex: "half",
    });
    assert.equal((await h.route(r)(stream)).status, 413);
    assert.equal(h.calls.length, 0);
  });

  it("accepts a body exactly at the limit", async () => {
    const h = harness();
    const body = "x".repeat(10);
    assert.equal((await send(h.route(rule({ maxBodyBytes: 10 })), body, { "x-signature": hmac(body) })).status, 200);
  });

  it("limits requests per client per minute, signed or not, and answers 429 with Retry-After", async () => {
    const h = harness();
    const route = h.route(rule({ ratePerMinute: 3 }));
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const headers: Record<string, string> = i % 2 === 0 ? { "x-signature": hmac("b") } : {};
      statuses.push((await send(route, "b", headers, "192.0.2.10")).status);
    }
    assert.deepEqual(statuses, [200, 401, 200, 429, 429]);
    const limited = await send(route, "b", { "x-signature": hmac("b") }, "192.0.2.10");
    assert.ok(Number(limited.headers.get("retry-after")) >= 1);
  });

  it("counts clients apart and forgets them after the minute", async () => {
    const h = harness();
    const route = h.route(rule({ ratePerMinute: 1 }));
    const headers = { "x-signature": hmac("b") };
    assert.equal((await send(route, "b", headers, "192.0.2.20")).status, 200);
    assert.equal((await send(route, "b", headers, "192.0.2.20")).status, 429);
    assert.equal((await send(route, "b", headers, "192.0.2.21")).status, 200);
    h.clock.now += 61_000;
    assert.equal((await send(route, "b", headers, "192.0.2.20")).status, 200);
  });

  it("shares one bucket when the request carries no client address", async () => {
    const h = harness();
    const route = h.route(rule({ ratePerMinute: 1 }));
    const noAddress = () => route(new Request(URL_, { method: "POST", body: "b", headers: { "x-signature": hmac("b") } }));
    assert.equal((await noAddress()).status, 200);
    assert.equal((await noAddress()).status, 429);
  });

  it("defaults to 60 a minute", async () => {
    const h = harness();
    const route = h.route(rule());
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await send(route, "b", { "x-signature": hmac("b") }, "192.0.2.30")).status;
    assert.equal(last, 429);
  });
});
