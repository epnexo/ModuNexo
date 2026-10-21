import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULT_DIST, distRecordPath, isDistName, newDistName, readLiveDist, removeStrayDists, writeDistTsconfig, writeLiveDist } from "../src/install/dist.ts";

let root: string;
let webRoot: string;
let dataDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "modunexo-dist-"));
  webRoot = join(root, "web");
  dataDir = join(root, "var");
  mkdirSync(webRoot, { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A directory that looks like a finished build. */
const build = (name: string) => {
  mkdirSync(join(webRoot, name), { recursive: true });
  writeFileSync(join(webRoot, name, "BUILD_ID"), name);
};
const record = (text: string) => {
  mkdirSync(join(dataDir, "run"), { recursive: true });
  writeFileSync(distRecordPath(dataDir), text);
};

describe("isDistName and newDistName", () => {
  it("accepts .next and .next-<letters and digits>, and nothing that could leave the web folder", () => {
    for (const name of [".next", ".next-a", ".next-0k3j9x2", ".next-ABC123"]) assert.equal(isDistName(name), true, name);
    for (const name of ["", "next", ".nextt", ".next-", ".next--a", ".next-a-b", ".next/", ".next/x", "../.next", ".next-../x", ".next-a b", ".next-a\n", "/abs", ".next.rollback", ".NEXT", ".next-" + "a".repeat(25)]) {
      assert.equal(isDistName(name), false, JSON.stringify(name));
    }
    assert.equal(DEFAULT_DIST, ".next");
  });

  it("makes a new name each time, and a valid one", () => {
    const names = new Set(Array.from({ length: 50 }, () => newDistName()));
    assert.equal(names.size, 50);
    for (const name of names) assert.equal(isDistName(name), true, name);
    assert.equal(newDistName(() => 1_000_000, () => "ab12"), `.next-${(1_000_000).toString(36)}ab12`);
  });
});

describe("readLiveDist", () => {
  it("is .next when nothing was ever recorded", () => {
    build(".next");
    assert.deepEqual(readLiveDist(webRoot, dataDir), { name: ".next", recorded: false, reason: null });
  });

  it("is the recorded directory when it is a finished build", () => {
    build(".next");
    build(".next-abc");
    record(".next-abc\n");
    assert.deepEqual(readLiveDist(webRoot, dataDir), { name: ".next-abc", recorded: true, reason: null });
    record(".next");
    assert.deepEqual(readLiveDist(webRoot, dataDir), { name: ".next", recorded: true, reason: null });
  });

  it("falls back to .next, and says why, when the record cannot be trusted", () => {
    build(".next");
    const cases: Array<[string, RegExp]> = [
      ["", /empty/],
      ["../etc\n", /not a build directory name/],
      [".next/../..", /not a build directory name/],
      [".nextx", /not a build directory name/],
      [".next-gone\n", /does not exist/],
    ];
    for (const [text, why] of cases) {
      record(text);
      const live = readLiveDist(webRoot, dataDir);
      assert.equal(live.name, ".next", JSON.stringify(text));
      assert.match(String(live.reason), why, JSON.stringify(text));
    }
    const huge = "x".repeat(5000);
    record(huge);
    const echoed = readLiveDist(webRoot, dataDir);
    assert.equal(echoed.name, ".next");
    assert.ok(String(echoed.reason).length < 200, `the reason is short: ${String(echoed.reason).length} characters`);
    mkdirSync(join(webRoot, ".next-half"));
    record(".next-half");
    const half = readLiveDist(webRoot, dataDir);
    assert.equal(half.name, ".next");
    assert.match(String(half.reason), /BUILD_ID/);
  });
});

describe("writeLiveDist", () => {
  it("records the name, replaces an earlier record and leaves no partial file", () => {
    writeLiveDist(dataDir, ".next-one");
    assert.equal(readFileSync(distRecordPath(dataDir), "utf8"), ".next-one\n");
    writeLiveDist(dataDir, ".next-two");
    assert.equal(readFileSync(distRecordPath(dataDir), "utf8"), ".next-two\n");
    assert.deepEqual(readdirSync(join(dataDir, "run")), ["web.dist"], "no partial file is left beside the record");
  });

  it("refuses a name that is not a build directory name, and records nothing", () => {
    for (const name of ["../x", "", ".next/x", "other"]) assert.throws(() => writeLiveDist(dataDir, name), /not a build directory name/, JSON.stringify(name));
    assert.equal(existsSync(distRecordPath(dataDir)), false);
  });
});

describe("writeDistTsconfig", () => {
  const base = { extends: "../../tsconfig.base.json", compilerOptions: { jsx: "react-jsx" }, include: ["next-env.d.ts", "src", "scripts", "test", "next.config.ts", ".next/types/**/*.ts", ".next/dev/types/**/*.ts"], exclude: ["node_modules"] };

  it("extends the app's tsconfig and names only its own directory's types, never the live one's", () => {
    writeFileSync(join(webRoot, "tsconfig.json"), JSON.stringify(base));
    const file = writeDistTsconfig(webRoot, ".next-abc");
    assert.equal(file, join(webRoot, "tsconfig.next-abc.json"));
    const written = JSON.parse(readFileSync(file!, "utf8")) as { extends: string; include: string[] };
    assert.equal(written.extends, "./tsconfig.json");
    assert.deepEqual(written.include, ["next-env.d.ts", "src", "scripts", "test", "next.config.ts", ".next-abc/types/**/*.ts"]);
  });

  it("writes nothing for the default directory, which the app's own tsconfig already names", () => {
    writeFileSync(join(webRoot, "tsconfig.json"), JSON.stringify(base));
    assert.equal(writeDistTsconfig(webRoot, ".next"), null);
    assert.equal(existsSync(join(webRoot, "tsconfig.next.json")), false);
  });

  it("refuses a name that is not a build directory name", () => {
    writeFileSync(join(webRoot, "tsconfig.json"), JSON.stringify(base));
    assert.throws(() => writeDistTsconfig(webRoot, "../x"), /not a build directory name/);
  });
});

describe("removeStrayDists", () => {
  // Names of the shape `newDistName` makes: a time and a few random characters, lowercase.
  const OLD = ".next-stray0001";
  const OLDER = ".next-stray0002";
  const LIVE = ".next-live0001";
  const strays = () => [".next", OLD, OLDER, LIVE];

  it("removes every build directory and tsconfig that is neither kept nor the live one's, and nothing else", () => {
    for (const name of strays()) build(name);
    writeFileSync(join(webRoot, `tsconfig${OLD}.json`), "{}");
    writeFileSync(join(webRoot, `tsconfig${LIVE}.json`), "{}");
    writeFileSync(join(webRoot, "tsconfig.json"), "{}");
    mkdirSync(join(webRoot, ".next.rollback"));
    mkdirSync(join(webRoot, ".nextra"));
    mkdirSync(join(webRoot, "node_modules"));
    const removed = removeStrayDists(webRoot, [LIVE]);
    assert.deepEqual(removed.sort(), [".next", OLD, OLDER, `tsconfig${OLD}.json`].sort());
    for (const kept of [LIVE, `tsconfig${LIVE}.json`, "tsconfig.json", ".next.rollback", ".nextra", "node_modules"]) {
      assert.equal(existsSync(join(webRoot, kept)), true, kept);
    }
    for (const gone of [".next", OLD, OLDER, `tsconfig${OLD}.json`]) assert.equal(existsSync(join(webRoot, gone)), false, gone);
  });

  it("never removes what the platform did not make: a folder, a file or a tsconfig of yours that merely starts like a build", () => {
    mkdirSync(join(webRoot, ".next-backup"));
    writeFileSync(join(webRoot, ".next-backup", "precious.txt"), "keep");
    writeFileSync(join(webRoot, ".next-notes"), "keep");
    mkdirSync(join(webRoot, ".next-UPPERCASE0001"));
    mkdirSync(join(webRoot, ".next-short"));
    writeFileSync(join(webRoot, "tsconfig.next-mine.json"), "{}");
    build(OLD);
    assert.deepEqual(removeStrayDists(webRoot, []), [OLD]);
    for (const kept of [".next-backup/precious.txt", ".next-notes", ".next-UPPERCASE0001", ".next-short", "tsconfig.next-mine.json"]) {
      assert.equal(existsSync(join(webRoot, kept)), true, kept);
    }
  });

  it("keeps several directories when asked to (the live one and the one being built)", () => {
    for (const name of strays()) build(name);
    assert.deepEqual(removeStrayDists(webRoot, [LIVE, OLD]).sort(), [".next", OLDER]);
  });

  it("removes nothing right after a switch, because the server it replaced may still be draining", () => {
    for (const name of strays()) build(name);
    writeLiveDist(dataDir, LIVE);
    assert.deepEqual(removeStrayDists(webRoot, [LIVE], { recordPath: distRecordPath(dataDir) }), []);
    for (const name of strays()) assert.equal(existsSync(join(webRoot, name)), true, name);
    const earlier = new Date(Date.now() - 120_000);
    utimesSync(distRecordPath(dataDir), earlier, earlier);
    assert.equal(removeStrayDists(webRoot, [LIVE], { recordPath: distRecordPath(dataDir) }).length, 3);
  });

  it("follows no link out of the web folder", () => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "precious.txt"), "keep");
    symlinkSync(outside, join(webRoot, ".next-link00001"));
    assert.deepEqual(removeStrayDists(webRoot, []), [".next-link00001"]);
    assert.equal(readFileSync(join(outside, "precious.txt"), "utf8"), "keep");
  });

  it("does nothing when the web folder does not exist", () => {
    assert.deepEqual(removeStrayDists(join(root, "missing"), []), []);
  });
});
