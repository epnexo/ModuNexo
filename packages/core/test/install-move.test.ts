import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { PlacementRefusedError, placePackage, removePackage, undoPlacement } from "../src/install/place.ts";
import { moveDir } from "../src/install/move.ts";

let root: string;
const put = (path: string, content: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
};
const exdev = (): NodeJS.ErrnoException => Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
/** A rename that behaves like two mounted volumes: moving a folder out of `from` is refused, everything else works. */
const refusingFrom = (from: string) => (a: string, b: string) => {
  if (a === from) throw exdev();
  renameSync(a, b);
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "modunexo-move-")));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("moveDir", () => {
  it("renames when the folders share a device", () => {
    put("a/file.txt", "x");
    moveDir(join(root, "a"), join(root, "b"), renameSync);
    assert.equal(existsSync(join(root, "a")), false);
    assert.equal(readFileSync(join(root, "b/file.txt"), "utf8"), "x");
  });

  it("copies and then removes the source when the rename crosses devices, keeping symlinks as links", () => {
    put("a/package.json", "{}");
    put("a/web/page.tsx", "page\n");
    symlinkSync("package.json", join(root, "a/link"));
    mkdirSync(join(root, "kept"));
    moveDir(join(root, "a"), join(root, "kept/b"), refusingFrom(join(root, "a")));
    assert.equal(existsSync(join(root, "a")), false);
    assert.equal(readFileSync(join(root, "kept/b/web/page.tsx"), "utf8"), "page\n");
    assert.equal(lstatSync(join(root, "kept/b/link")).isSymbolicLink(), true);
    assert.equal(readlinkSync(join(root, "kept/b/link")), "package.json");
    assert.deepEqual(readdirSync(join(root, "kept")), ["b"], "no half-copied folder is left beside the result");
  });

  it("keeps the mode of the files it copies", () => {
    put("a/run.sh", "#!/bin/sh\n");
    chmodSync(join(root, "a/run.sh"), 0o755);
    moveDir(join(root, "a"), join(root, "b"), refusingFrom(join(root, "a")));
    assert.equal(statSync(join(root, "b/run.sh")).mode & 0o777, 0o755);
  });

  it("passes any other error through untouched and leaves the source where it was", () => {
    put("a/file.txt", "x");
    const boom = () => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    };
    assert.throws(() => moveDir(join(root, "a"), join(root, "b"), boom), /EACCES/);
    assert.equal(readFileSync(join(root, "a/file.txt"), "utf8"), "x");
    assert.equal(existsSync(join(root, "b")), false);
  });

  it("leaves the source whole and no partial copy when the copy fails", (t) => {
    if (process.getuid?.() === 0) return t.skip("root can read an unreadable file");
    put("a/ok.txt", "ok");
    put("a/secret.txt", "no");
    chmodSync(join(root, "a/secret.txt"), 0o000);
    try {
      assert.throws(() => moveDir(join(root, "a"), join(root, "b"), refusingFrom(join(root, "a"))));
      assert.equal(readFileSync(join(root, "a/ok.txt"), "utf8"), "ok");
      assert.deepEqual(readdirSync(root).sort(), ["a"], "nothing of the failed copy remains");
    } finally {
      chmodSync(join(root, "a/secret.txt"), 0o644);
    }
  });

  it("refuses to overwrite a target that already exists", () => {
    put("a/file.txt", "x");
    put("b/other.txt", "y");
    assert.throws(() => moveDir(join(root, "a"), join(root, "b"), refusingFrom(join(root, "a"))), /exist/i);
    assert.equal(readFileSync(join(root, "a/file.txt"), "utf8"), "x");
    assert.equal(readFileSync(join(root, "b/other.txt"), "utf8"), "y");
  });

  it("really crosses devices when the machine has two", (t) => {
    const other = "/dev/shm";
    if (!existsSync(other) || statSync(other).dev === statSync(root).dev) return t.skip("no second device to test with");
    const scratch = mkdtempSync(join(other, "modunexo-move-"));
    try {
      put("a/web/page.tsx", "page\n");
      moveDir(join(root, "a"), join(scratch, "b"));
      assert.equal(existsSync(join(root, "a")), false);
      assert.equal(readFileSync(join(scratch, "b/web/page.tsx"), "utf8"), "page\n");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("placing and removing a module across two volumes", () => {
  const modulesDir = () => join(root, "modules");
  const dataDir = () => join(root, "var");
  const base = () => ({ moduleId: "reports", packageName: "@acme/reports", modulesDir: modulesDir(), nodeModulesDir: join(root, "node_modules"), dataDir: dataDir() });
  beforeEach(() => {
    mkdirSync(modulesDir());
    mkdirSync(join(root, "node_modules"));
    put("var/staging/new/package.json", '{"name":"@acme/reports","version":"2.0.0"}');
    put("var/staging/new/web/page.tsx", "new\n");
    put("modules/reports/package.json", '{"name":"@acme/reports","version":"1.0.0"}');
    put("modules/reports/web/page.tsx", "old\n");
  });

  const upgrade = (rename: (a: string, b: string) => void) =>
    placePackage({ ...base(), stagingDir: join(dataDir(), "staging/new"), version: "2.0.0", kind: "upgrade", previousVersion: "1.0.0", rename });

  it("upgrades a module when the kept copy lives on another volume than the modules folder", () => {
    const placement = upgrade(refusingFrom(join(modulesDir(), "reports")));
    assert.equal(readFileSync(join(modulesDir(), "reports/web/page.tsx"), "utf8"), "new\n");
    assert.equal(readFileSync(join(dataDir(), "previous/reports-1.0.0/web/page.tsx"), "utf8"), "old\n");
    assert.equal(placement.previousDir, join(dataDir(), "previous/reports-1.0.0"));
  });

  it("undoes that upgrade back to the old version, also across volumes", () => {
    const rename = refusingFrom(join(modulesDir(), "reports"));
    const refusingBack = (a: string, b: string) => {
      if (a === join(dataDir(), "previous/reports-1.0.0")) throw exdev();
      rename(a, b);
    };
    const placement = upgrade(rename);
    undoPlacement(placement.state, refusingBack);
    assert.equal(readFileSync(join(modulesDir(), "reports/web/page.tsx"), "utf8"), "old\n");
    assert.equal(existsSync(join(dataDir(), "previous/reports-1.0.0")), false);
  });

  it("moves an uninstalled module to var/removed when that is another volume", () => {
    const kept = removePackage({ ...base(), version: "1.0.0", rename: refusingFrom(join(modulesDir(), "reports")) });
    assert.equal(kept, join(dataDir(), "removed/reports-1.0.0"));
    assert.equal(existsSync(join(modulesDir(), "reports")), false);
    assert.equal(readFileSync(join(dataDir(), "removed/reports-1.0.0/web/page.tsx"), "utf8"), "old\n");
  });

  it("sweeps a half-made copy a dead process left in the modules folder", () => {
    const placement = upgrade(refusingFrom(join(modulesDir(), "reports")));
    put("modules/.reports.moving-abc123/package.json", "{}");
    undoPlacement(placement.state, refusingFrom(join(dataDir(), "previous/reports-1.0.0")));
    assert.deepEqual(readdirSync(modulesDir()), ["reports"]);
  });

  it("still refuses what it refused before", () => {
    assert.throws(() => placePackage({ ...base(), stagingDir: join(dataDir(), "staging/new"), version: "2.0.0", kind: "install" }), PlacementRefusedError);
  });
});
