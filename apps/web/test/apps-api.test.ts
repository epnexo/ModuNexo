import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type AppsDeps, handleStart, handleState, handleUpload, plainActor } from "../src/server/apps-api.ts";

const SHA = "ab".repeat(32);
const ADMIN = { actor: "admin@example.test", canWrite: true };
const USER = { actor: "user@example.test", canWrite: false };

interface Calls {
  receive: { expectedSha256?: string; actor: string }[];
  launch: { sha256: string; actor: string }[];
}

function deps(overrides: Partial<AppsDeps> = {}): { deps: AppsDeps; calls: Calls } {
  const calls: Calls = { receive: [], launch: [] };
  const base: AppsDeps = {
    viewer: async () => ADMIN,
    receive: async (_body, options) => {
      calls.receive.push(options);
      return { ok: true, sha256: SHA, sizeBytes: 10, alreadyStaged: false, review: { id: "reports", version: "1.0.0" } } as never;
    },
    isStaged: async () => true,
    launch: async (sha256, actor) => {
      calls.launch.push({ sha256, actor });
      return { pid: 4242, logFile: "/var/logs/x.log" };
    },
    state: async () => ({ operations: [], packages: [], running: null }),
    maxUploadBytes: 1000,
  };
  return { deps: { ...base, ...overrides }, calls };
}

const same = { origin: "http://h", host: "h" };
const post = (path: string, init: { headers?: Record<string, string>; body?: BodyInit | null } = {}) =>
  new Request(`http://h${path}`, { method: "POST", headers: { ...same, ...init.headers }, body: init.body ?? null });
const read = async (response: Response) => (await response.json()) as Record<string, unknown>;

describe("handleUpload", () => {
  it("stages an uploaded archive for an administrator and returns its review", async () => {
    const { deps: d, calls } = deps();
    const response = await handleUpload(post("/api/apps/packages", { body: "archive-bytes", headers: { "x-expected-sha256": SHA } }), d);
    assert.equal(response.status, 200);
    const body = await read(response);
    assert.equal(body.status, "staged");
    assert.equal(body.sha256, SHA);
    assert.deepEqual(calls.receive, [{ actor: ADMIN.actor, expectedSha256: SHA }]);
    assert.equal(response.headers.get("cache-control"), "no-store");
  });

  it("is refused for another site, no session, and a user who is not an administrator, before the body is read", async () => {
    const cross = deps();
    assert.equal((await handleUpload(new Request("http://h/api/apps/packages", { method: "POST", headers: { origin: "http://evil", host: "h" }, body: "x" }), cross.deps)).status, 403);
    const anonymous = deps({ viewer: async () => null });
    assert.equal((await handleUpload(post("/api/apps/packages", { body: "x" }), anonymous.deps)).status, 401);
    const plain = deps({ viewer: async () => USER });
    assert.equal((await handleUpload(post("/api/apps/packages", { body: "x" }), plain.deps)).status, 403);
    assert.deepEqual([cross.calls.receive, anonymous.calls.receive, plain.calls.receive], [[], [], []]);
  });

  it("refuses a declared length over the limit with 413 without reading, and a malformed expected hash with 400", async () => {
    const { deps: d, calls } = deps();
    const big = await handleUpload(post("/api/apps/packages", { body: "x", headers: { "content-length": "5000" } }), d);
    assert.equal(big.status, 413);
    const bad = await handleUpload(post("/api/apps/packages", { body: "x", headers: { "x-expected-sha256": "nope" } }), d);
    assert.equal(bad.status, 400);
    const empty = await handleUpload(post("/api/apps/packages"), d);
    assert.equal(empty.status, 400);
    assert.deepEqual(calls.receive, []);
  });

  it("answers 422 with every problem when the package is refused, and 413 when the stream went over", async () => {
    const refused = deps({ receive: async () => ({ ok: false, sha256: SHA, sizeBytes: 3, problems: ["a is wrong", "b is wrong"] }) });
    const response = await handleUpload(post("/api/apps/packages", { body: "x" }), refused.deps);
    assert.equal(response.status, 422);
    assert.deepEqual((await read(response)).problems, ["a is wrong", "b is wrong"]);
    const { UploadTooLargeError } = await import("@epnexo/core/apps");
    const over = deps({ receive: async () => { throw new UploadTooLargeError(1000); } });
    assert.equal((await handleUpload(post("/api/apps/packages", { body: "x" }), over.deps)).status, 413);
  });
});

describe("handleStart", () => {
  const json = (body: unknown) => post("/api/apps/operations", { body: JSON.stringify(body), headers: { "content-type": "application/json" } });

  it("starts the apply of a staged package as the signed-in user and answers 202", async () => {
    const { deps: d, calls } = deps();
    const response = await handleStart(json({ sha256: SHA }), d);
    assert.equal(response.status, 202);
    assert.deepEqual(calls.launch, [{ sha256: SHA, actor: ADMIN.actor }]);
    const body = await read(response);
    assert.equal(body.status, "started");
    assert.equal("pid" in body, false, "no process detail is sent to the browser");
    assert.equal("logFile" in body, false);
  });

  it("refuses a body that is not { sha256 } with a 64-hex value, and a package that was never staged", async () => {
    const { deps: d, calls } = deps();
    for (const body of [{}, { sha256: "nope" }, { sha256: SHA, extra: 1 }, [], "x", { sha256: 5 }]) {
      assert.equal((await handleStart(json(body), d)).status, 400, JSON.stringify(body));
    }
    const missing = deps({ isStaged: async () => false });
    assert.equal((await handleStart(json({ sha256: SHA }), missing.deps)).status, 404);
    assert.deepEqual([calls.launch, missing.calls.launch], [[], []]);
  });

  it("is refused for a visitor who may not write, and with 409 while a run is alive", async () => {
    const plain = deps({ viewer: async () => USER });
    assert.equal((await handleStart(json({ sha256: SHA }), plain.deps)).status, 403);
    const { LaunchBusyError } = await import("@epnexo/core/apps");
    const busy = deps({
      launch: async () => {
        throw new LaunchBusyError({ moduleId: "x", version: "1", sha256: SHA, kind: "install", status: "running", step: "build", detail: null, actor: "a", pid: 1, startedAt: new Date(), finishedAt: null, id: 1 });
      },
    });
    const response = await handleStart(json({ sha256: SHA }), busy.deps);
    assert.equal(response.status, 409);
    assert.match(String((await read(response)).error), /another operation/);
  });
});

describe("handleState", () => {
  it("returns the runs and packages to an administrator, and nothing to anyone else", async () => {
    const { deps: d } = deps({ state: async () => ({ operations: [{ id: 1 }], packages: [], running: null }) as never });
    const ok = await handleState(new Request("http://h/api/apps"), d);
    assert.equal(ok.status, 200);
    assert.deepEqual((await read(ok)).operations, [{ id: 1 }]);
    assert.equal((await handleState(new Request("http://h/api/apps"), deps({ viewer: async () => USER }).deps)).status, 403);
    assert.equal((await handleState(new Request("http://h/api/apps"), deps({ viewer: async () => null }).deps)).status, 401);
  });
});

describe("plainActor", () => {
  it("keeps an email, makes the local operator a plain name, and never returns something that starts like an option", () => {
    assert.equal(plainActor("admin@example.test"), "admin@example.test");
    assert.equal(plainActor("local operator"), "local-operator");
    assert.match(plainActor("--data-dir"), /^[A-Za-z0-9]/);
    assert.match(plainActor("   "), /^[A-Za-z0-9]/);
    assert.ok(plainActor("x".repeat(500)).length <= 100);
  });
});
