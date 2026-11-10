import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { REVEAL_MS, canReveal, revealClip } from "../src/lib/theme-reveal.ts";

describe("revealClip", () => {
  it("starts as a point at the center of the button and ends as a circle that covers the whole window", () => {
    const clip = revealClip({ left: 1380, top: 10, width: 36, height: 36 }, 1440, 900);
    assert.equal(clip.from, "circle(0px at 1398px 28px)");
    // The farthest corner from (1398, 28) is the bottom-left one.
    const radius = Math.ceil(Math.hypot(1398, 872));
    assert.equal(clip.to, `circle(${radius}px at 1398px 28px)`);
  });
  it("reaches the far corner whichever side of the window the button is on", () => {
    const left = revealClip({ left: 0, top: 0, width: 10, height: 10 }, 1000, 800);
    assert.equal(left.to, `circle(${Math.ceil(Math.hypot(995, 795))}px at 5px 5px)`);
  });
});

describe("canReveal", () => {
  it("needs View Transitions and no request for reduced motion", () => {
    assert.equal(canReveal(true, false), true);
    assert.equal(canReveal(false, false), false);
    assert.equal(canReveal(true, true), false);
  });
});

describe("REVEAL_MS", () => {
  it("is the 620 ms the design was approved with", () => {
    assert.equal(REVEAL_MS, 620);
  });
});
