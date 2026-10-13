import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRefusalLog } from "../src/server/refusal-log.ts";

describe("createRefusalLog", () => {
  it("logs the first refusal at once", () => {
    const lines: string[] = [];
    const log = createRefusalLog((line) => lines.push(line), () => 0);
    log("not-local", "refused GET / from 8.8.8.8");
    assert.deepEqual(lines, ["refused GET / from 8.8.8.8"]);
  });

  it("stays quiet for the same reason inside the window, so an attack cannot fill the log", () => {
    const lines: string[] = [];
    let now = 0;
    const log = createRefusalLog((line) => lines.push(line), () => now);
    log("not-local", "first");
    now = 30_000;
    log("not-local", "second");
    log("not-local", "third");
    assert.deepEqual(lines, ["first"]);
  });

  it("logs again after the window and says how many it kept quiet", () => {
    const lines: string[] = [];
    let now = 0;
    const log = createRefusalLog((line) => lines.push(line), () => now);
    log("not-local", "first");
    log("not-local", "second");
    log("not-local", "third");
    now = 60_000;
    log("not-local", "fourth");
    assert.deepEqual(lines, ["first", "fourth (2 similar refusals in the last minute were not logged)"]);
  });

  it("keeps a separate window per reason", () => {
    const lines: string[] = [];
    const log = createRefusalLog((line) => lines.push(line), () => 0);
    log("not-local", "a");
    log("bad-host", "b");
    assert.deepEqual(lines, ["a", "b"]);
  });
});
