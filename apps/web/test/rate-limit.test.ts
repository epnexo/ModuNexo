import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRateLimiter } from "../src/server/rate-limit.ts";

describe("createRateLimiter", () => {
  it("lets a key through up to its limit and then answers how many seconds to wait", () => {
    let now = 1_000_000;
    const limiter = createRateLimiter(() => now);
    assert.deepEqual([limiter.hit("a", 3), limiter.hit("a", 3), limiter.hit("a", 3)], [0, 0, 0]);
    assert.equal(limiter.hit("a", 3), 60);
    now += 20_000;
    assert.equal(limiter.hit("a", 3), 40);
    now += 39_999;
    assert.equal(limiter.hit("a", 3), 1);
  });

  it("starts a new window a minute after the first hit", () => {
    let now = 0;
    const limiter = createRateLimiter(() => now);
    limiter.hit("a", 1);
    assert.ok(limiter.hit("a", 1) > 0);
    now = 60_000;
    assert.equal(limiter.hit("a", 1), 0);
  });

  it("counts keys apart", () => {
    const limiter = createRateLimiter(() => 0);
    limiter.hit("a", 1);
    assert.ok(limiter.hit("a", 1) > 0);
    assert.equal(limiter.hit("b", 1), 0);
  });

  it("applies the limit given at each hit, so one key can be used with two limits", () => {
    const limiter = createRateLimiter(() => 0);
    limiter.hit("a", 5);
    limiter.hit("a", 5);
    assert.ok(limiter.hit("a", 2) > 0);
    assert.equal(limiter.hit("a", 5), 0);
  });

  it("forgets expired windows once many keys are tracked, so a flood of addresses does not grow without bound", () => {
    let now = 0;
    const limiter = createRateLimiter(() => now);
    for (let i = 0; i < 1500; i++) limiter.hit(`k${i}`, 1);
    assert.equal(limiter.size(), 1500);
    now = 61_000;
    limiter.hit("fresh", 1);
    assert.equal(limiter.size(), 1, "only the live window is left");
  });
});
