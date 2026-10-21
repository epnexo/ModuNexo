import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { distRecordPath, writeLiveDist } from "../src/install/dist.ts";
import { writeJournal } from "../src/install/journal.ts";
import { prepareServerStart } from "../src/install/start.ts";

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
    build(".next-old");
    build(".next-live");
    writeFileSync(join(webRoot, "tsconfig.next-old.json"), "{}");
    writeLiveDist(dataDir, ".next-live");
    age();
    const start = prepareServerStart(webRoot, dataDir);
    assert.equal(start.dist, ".next-live");
    assert.equal(start.warning, null);
    assert.deepEqual(start.removed.sort(), [".next", ".next-old", "tsconfig.next-old.json"]);
    assert.equal(existsSync(join(webRoot, ".next-live")), true);
  });

  it("removes nothing in the minute after a switch: the server it replaced may still be draining", () => {
    build(".next");
    build(".next-live");
    writeLiveDist(dataDir, ".next-live");
    assert.deepEqual(prepareServerStart(webRoot, dataDir).removed, []);
    assert.equal(existsSync(join(webRoot, ".next")), true);
  });

  it("leaves alone the directory a run is building right now, which its journal names", () => {
    build(".next");
    build(".next-live");
    build(".next-building");
    writeLiveDist(dataDir, ".next-live");
    age();
    writeJournal(dataDir, { type: "change", moduleId: "reports", action: "disable", expected: "disabled", version: "1.0.0", phase: "building", webRoot, dist: ".next-building" });
    const start = prepareServerStart(webRoot, dataDir);
    assert.deepEqual(start.removed, [".next"]);
    assert.equal(existsSync(join(webRoot, ".next-building")), true, "a restart in the middle of an install must not pull the build from under it");
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
