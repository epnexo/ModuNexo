import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

const load = async (dist: string | undefined) => {
  if (dist === undefined) delete process.env.MODUNEXO_DIST_DIR;
  else process.env.MODUNEXO_DIST_DIR = dist;
  // A new query string makes a new module, so the variable is read again.
  return ((await import(`../next.config.ts?dist=${encodeURIComponent(String(dist))}&t=${Math.random()}`)) as { default: { distDir?: string; typescript?: { tsconfigPath?: string } } }).default;
};

const original = process.env.MODUNEXO_DIST_DIR;
afterEach(() => {
  if (original === undefined) delete process.env.MODUNEXO_DIST_DIR;
  else process.env.MODUNEXO_DIST_DIR = original;
});

describe("next.config: the build directory", () => {
  it("is .next, with the app's own tsconfig, when nothing says otherwise", async () => {
    for (const unset of [undefined, "", ".next"]) {
      const config = await load(unset);
      assert.equal(config.distDir, ".next", String(unset));
      assert.equal(config.typescript, undefined, `${String(unset)}: the default directory is type-checked by the app's tsconfig.json`);
    }
  });

  it("follows MODUNEXO_DIST_DIR and type-checks with the tsconfig written for that directory", async () => {
    const config = await load(".next-abc123");
    assert.equal(config.distDir, ".next-abc123");
    assert.equal(config.typescript?.tsconfigPath, "tsconfig.next-abc123.json");
  });

  it("refuses a value that is not a build directory name, so the variable cannot point outside the web folder", async () => {
    for (const bad of ["../x", "/tmp/x", ".next/x", "other", ".next-a b", ".next-"]) {
      await assert.rejects(() => load(bad), /MODUNEXO_DIST_DIR/, bad);
    }
  });
});
