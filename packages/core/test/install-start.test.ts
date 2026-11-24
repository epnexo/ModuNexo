import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { SWITCH_GRACE_MS, distRecordPath, writeLiveDist } from "../src/install/dist.ts";
import { writeJournal } from "../src/install/journal.ts";
import { prepareServerStart, scheduleStrayCleanup } from "../src/install/start.ts";

let root: string;
let webRoot: string;
let dataDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "modunexo-start-"));
  webRoot = join(root, "web");
  dataDir = join(root, "var");
  mkdirSync(webRoot, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const build = (name: string) => {
  mkdirSync(join(webRoot, name), { recursive: true });
  writeFileSync(join(webRoot, name, "BUILD_ID"), name);
};
/** Makes the record old enough that a directory it replaced is no longer thought to be draining. */
const age = () => {
  const earlier = new Date(Date.now() - 120_000);
  utimesSync(distRecordPath(dataDir), earlier, earlier);
};

describe("prepareServerStart", () => {
  it("serves .next when nothing was ever recorded", () => {
    build(".next");
    assert.deepEqual(prepareServerStart(webRoot, dataDir), { dist: ".next", warning: null, removed: [] });
  });

  it("serves the recorded build and removes the directories nobody serves", () => {
    build(".next");
    build(".next-stray0001");
    build(".next-live0001");
    writeFileSync(join(webRoot, "tsconfig.next-stray0001.json"), "{}");
    writeLiveDist(dataDir, ".next-live0001");
    age();
    const start = prepareServerStart(webRoot, dataDir);
    assert.equal(start.dist, ".next-live0001");
    assert.equal(start.warning, null);
    assert.deepEqual(start.removed.sort(), [".next", ".next-stray0001", "tsconfig.next-stray0001.json"]);
    assert.equal(existsSync(join(webRoot, ".next-live0001")), true);
  });

  it("removes nothing in the minute after a switch: the server it replaced may still be draining", () => {
    build(".next");
    build(".next-live0001");
    writeLiveDist(dataDir, ".next-live0001");
    assert.deepEqual(prepareServerStart(webRoot, dataDir).removed, []);
    assert.equal(existsSync(join(webRoot, ".next")), true);
  });

  it("leaves alone the directory a run is building right now, which its journal names", () => {
    build(".next");
    build(".next-live0001");
    build(".next-building01");
    writeLiveDist(dataDir, ".next-live0001");
    age();
    writeJournal(dataDir, { type: "change", moduleId: "reports", action: "disable", expected: "disabled", version: "1.0.0", phase: "building", webRoot, dist: ".next-building01" });
    const start = prepareServerStart(webRoot, dataDir);
    assert.deepEqual(start.removed, [".next"]);
    assert.equal(existsSync(join(webRoot, ".next-building01")), true, "a restart in the middle of an install must not pull the build from under it");
  });

  it("falls back to .next and says why when the record names a directory that is not there", () => {
    build(".next");
    writeLiveDist(dataDir, ".next-gone");
    const start = prepareServerStart(webRoot, dataDir);
    assert.equal(start.dist, ".next");
    assert.match(String(start.warning), /\.next-gone does not exist/);
  });

  it("a web folder with nothing built yet is not an error: .next is what a first build will make", () => {
    assert.deepEqual(prepareServerStart(join(root, "missing"), dataDir), { dist: ".next", warning: null, removed: [] });
  });
});

describe("scheduleStrayCleanup", () => {
  /** A timer the test fires by hand, so nothing waits for a minute. */
  const fakeTimers = () => {
    const timers: { fn: () => void; ms: number; unref: boolean; cleared: boolean }[] = [];
    return {
      timers,
      setTimer: (fn: () => void, ms: number) => {
        const timer = { fn, ms, unref: false, cleared: false };
        timers.push(timer);
        return Object.assign(timer, { unref() { timer.unref = true; } });
      },
      clearTimer: (handle: unknown) => {
        (handle as { cleared: boolean }).cleared = true;
      },
    };
  };

  it("waits out the grace after a switch and then clears the builds nobody serves, which is what an upgrade leaves behind", () => {
    build(".next");
    build(".next-previous01");
    build(".next-live0001");
    writeFileSync(join(webRoot, "tsconfig.next-previous01.json"), "{}");
    writeLiveDist(dataDir, ".next-live0001");
    const clock = fakeTimers();
    const removed: string[][] = [];
    scheduleStrayCleanup(webRoot, dataDir, { ...clock, onRemoved: (names) => removed.push(names) });

    assert.equal(clock.timers.length, 1);
    assert.ok(clock.timers[0]!.ms > SWITCH_GRACE_MS, `fires after the grace, not at it: ${clock.timers[0]!.ms} ms`);
    assert.equal(clock.timers[0]!.unref, true, "it never keeps the supervisor alive");
    assert.equal(existsSync(join(webRoot, ".next-previous01")), true, "nothing is removed before the timer fires");

    age();
    clock.timers[0]!.fn();
    assert.deepEqual(removed.flat().sort(), [".next", ".next-previous01", "tsconfig.next-previous01.json"]);
    assert.equal(existsSync(join(webRoot, ".next-live0001")), true, "the build that is serving stays");
    assert.equal(existsSync(join(webRoot, ".next-previous01")), false);
  });

  it("leaves the build a run is making right now, which its journal names", () => {
    build(".next-live0001");
    build(".next-building01");
    writeLiveDist(dataDir, ".next-live0001");
    const clock = fakeTimers();
    scheduleStrayCleanup(webRoot, dataDir, clock);
    age();
    writeJournal(dataDir, { type: "change", moduleId: "reports", action: "disable", expected: "disabled", version: "1.0.0", phase: "building", webRoot, dist: ".next-building01" } as never);
    clock.timers[0]!.fn();
    assert.equal(existsSync(join(webRoot, ".next-building01")), true);
  });

  it("removes nothing when the build was switched again in the meantime: the new grace is running", () => {
    build(".next-old00001");
    build(".next-live0001");
    writeLiveDist(dataDir, ".next-live0001");
    const clock = fakeTimers();
    scheduleStrayCleanup(webRoot, dataDir, clock);
    clock.timers[0]!.fn();
    assert.equal(existsSync(join(webRoot, ".next-old00001")), true, "the record is fresh, so it is not the time yet");
  });

  it("can be cancelled, so a restart replaces the pending cleanup instead of stacking another", () => {
    build(".next-old00001");
    build(".next-live0001");
    writeLiveDist(dataDir, ".next-live0001");
    const clock = fakeTimers();
    const first = scheduleStrayCleanup(webRoot, dataDir, clock);
    first.cancel();
    assert.equal(clock.timers[0]!.cleared, true);
    first.cancel();
    assert.equal(clock.timers.length, 1, "cancelling twice is harmless");
  });

  it("does not throw when there is nothing to clean or the web folder is not there", () => {
    const clock = fakeTimers();
    scheduleStrayCleanup(join(root, "missing"), dataDir, clock);
    assert.doesNotThrow(() => clock.timers[0]!.fn());
  });
});
