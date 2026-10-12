import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MODULES_DIR, discoverModules } from "../src/discovery.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "epnexo-modules-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function addModule(folder: string, overrides: Record<string, unknown> = {}, file = "manifest.ts") {
  const manifest = {
    id: folder,
    version: "1.0.0",
    name: folder,
    platform: "^0.1.0",
    dependsOn: {},
    schema: folder.replaceAll("-", "_"),
    migrationsDir: "migrations",
    nav: [],
    ...overrides,
  };
  mkdirSync(join(root, folder), { recursive: true });
  writeFileSync(join(root, folder, file), `export default ${JSON.stringify(manifest)};\n`);
}

describe("discoverModules", () => {
  it("loads manifests from <dir>/*/manifest.ts sorted by folder and resolves migrationsDir", async () => {
    addModule("beta");
    addModule("alpha");
    const found = await discoverModules(root);
    assert.deepEqual(found.map((m) => m.id), ["alpha", "beta"]);
    assert.equal(found[0]?.migrationsDir, join(root, "alpha", "migrations"));
  });

  it("returns an empty list for an empty or missing directory", async () => {
    assert.deepEqual(await discoverModules(root), []);
    assert.deepEqual(await discoverModules(join(root, "missing")), []);
  });

  it("ignores folders and files without a manifest", async () => {
    addModule("alpha");
    mkdirSync(join(root, "no-manifest"));
    writeFileSync(join(root, ".gitkeep"), "");
    assert.equal((await discoverModules(root)).length, 1);
  });

  it("follows a symlinked module folder", async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "epnexo-linked-"));
    try {
      mkdirSync(join(elsewhere, "linked"));
      writeFileSync(
        join(elsewhere, "linked", "manifest.ts"),
        `export default ${JSON.stringify({ id: "linked", version: "1.0.0", name: "L", platform: "^0.1.0", dependsOn: {}, schema: "linked", migrationsDir: "migrations", nav: [] })};\n`,
      );
      symlinkSync(join(elsewhere, "linked"), join(root, "linked"), "dir");
      assert.deepEqual((await discoverModules(root)).map((m) => m.id), ["linked"]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("rejects a manifest whose id differs from its folder name", async () => {
    addModule("alpha", { id: "other", schema: "other" });
    await assert.rejects(discoverModules(root), /folder "alpha" declares id "other"/);
  });

  it("names the manifest file when it is invalid, listing the manifest problems", async () => {
    addModule("alpha", { schema: "Not Valid" });
    await assert.rejects(discoverModules(root), /alpha[/\\]manifest\.ts: Invalid manifest[^]*schema must be/);
  });

  it("rejects a v1-style manifest (no platform, dependsOn as a list)", async () => {
    addModule("alpha", { platform: undefined, dependsOn: [] });
    await assert.rejects(discoverModules(root), /platform[^]*dependsOn/);
  });

  it("requires a default export", async () => {
    mkdirSync(join(root, "alpha"));
    writeFileSync(join(root, "alpha", "manifest.ts"), "export const manifest = {};\n");
    await assert.rejects(discoverModules(root), /must have a default export/);
  });
});

describe("MODULES_DIR", () => {
  it("is the repository's modules directory", () => {
    assert.equal(basename(MODULES_DIR), "modules");
    assert.ok(existsSync(MODULES_DIR));
  });
});
