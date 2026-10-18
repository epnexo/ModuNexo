import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkHealth } from "../src/server/health.ts";

describe("checkHealth", () => {
  it("is ok when the database answers", async () => {
    const result = await checkHealth(async () => undefined, { timeoutMs: 200 });
    assert.deepEqual(result, { status: 200, body: { status: "ok", database: "ok" } });
  });

  it("is degraded, with the same short body, when the database fails, and does not leak why", async () => {
    const logged: unknown[] = [];
    const result = await checkHealth(
      async () => {
        throw new Error('password authentication failed for user "epnexo" at 10.0.0.5:5432');
      },
      { timeoutMs: 200, onFailure: (error) => logged.push(error) },
    );
    assert.deepEqual(result, { status: 503, body: { status: "degraded", database: "unreachable" } });
    assert.ok(!JSON.stringify(result).includes("epnexo"));
    assert.equal(logged.length, 1, "the reason goes to the log, not to the caller");
  });

  it("is degraded when the database does not answer in time, instead of hanging the probe", async () => {
    const started = Date.now();
    const result = await checkHealth(() => new Promise(() => undefined), { timeoutMs: 50 });
    assert.equal(result.status, 503);
    assert.ok(Date.now() - started < 1_000);
  });

  it("is degraded when the platform cannot even be reached (a missing configuration throws synchronously)", async () => {
    const result = await checkHealth(() => {
      throw new Error("DATABASE_URL is not set");
    }, { timeoutMs: 200 });
    assert.equal(result.status, 503);
  });
});
