import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runCli } from "../src/cli/run.ts";

const repoNodeModules = join(dirname(fileURLToPath(import.meta.url)), "../../../node_modules");

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "modunexo-cli-new-"));
  // A module folder resolves "@modunexo/sdk" by walking up to a node_modules, as it does under the repository.
  symlinkSync(repoNodeModules, join(work, "node_modules"));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

async function cli(...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(args, { out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const files = (root: string): string[] =>
  readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))
    .sort();

describe("modules new", () => {
  it("writes a module folder that uses getDb and names everything after the id", async () => {
    const result = await cli("modules", "new", "field-notes", "--dir", work);
    assert.equal(result.code, 0, result.err);
    const folder = join(work, "field-notes");
    assert.deepEqual(files(folder), ["manifest.ts", "migrations/0001_init.sql", "package.json", "web/page.tsx"]);
    const manifest = readFileSync(join(folder, "manifest.ts"), "utf8");
    assert.match(manifest, /id: "field-notes"/);
    assert.match(manifest, /schema: "field_notes"/);
    assert.match(manifest, /name: "Field Notes"/);
    assert.equal(JSON.parse(readFileSync(join(folder, "package.json"), "utf8")).name, "@local/field-notes");
    assert.match(readFileSync(join(folder, "web/page.tsx"), "utf8"), /getDb\("field-notes"\)/);
    assert.match(result.out, /field-notes/);
    assert.match(result.out, /modules pack/, "says what to do next");
  });

  it("produces a module the platform accepts: it packs, and the archive is reviewed by intake rules", async () => {
    await cli("modules", "new", "field-notes", "--name", 'Bob\'s "Field" Notes', "--dir", work);
    const archive = join(work, "field-notes.tgz");
    const packed = await cli("modules", "pack", join(work, "field-notes"), "--out", archive);
    assert.equal(packed.code, 0, packed.err);
    assert.match(packed.out, /sha256 [0-9a-f]{64}/);
    assert.ok(existsSync(archive));
  });

  it("refuses an id that is not kebab-case, is reserved, or would give a reserved schema, and writes nothing", async () => {
    for (const id of ["Field_Notes", "core", "public", "9lives"]) {
      const result = await cli("modules", "new", id, "--dir", work);
      assert.equal(result.code, 3, `${id}: ${result.err}`);
      assert.match(result.err, /id|schema|reserved/i);
    }
    assert.deepEqual(readdirSync(work), ["node_modules"]);
  });

  it("refuses to touch a folder that already exists", async () => {
    mkdirSync(join(work, "field-notes"));
    writeFileSync(join(work, "field-notes", "keep.txt"), "mine");
    const result = await cli("modules", "new", "field-notes", "--dir", work);
    assert.equal(result.code, 3);
    assert.match(result.err, /already exists/);
    assert.deepEqual(files(join(work, "field-notes")), ["keep.txt"]);
  });

  it("refuses, naming the place, when --dir is a file or the target is a dangling symlink", async () => {
    writeFileSync(join(work, "a-file"), "x");
    const onFile = await cli("modules", "new", "field-notes", "--dir", join(work, "a-file"));
    assert.equal(onFile.code, 3, onFile.err);
    assert.match(onFile.err, /cannot write to .*a-file/);
    symlinkSync(join(work, "gone"), join(work, "field-notes"));
    const dangling = await cli("modules", "new", "field-notes", "--dir", work);
    assert.equal(dangling.code, 3, dangling.err);
    assert.deepEqual(readdirSync(work).filter((name) => name.startsWith(".")), [], "no staging folder left behind");
  });

  it("is a usage error without an id or with extra arguments, and its help is listed", async () => {
    assert.equal((await cli("modules", "new")).code, 2);
    assert.equal((await cli("modules", "new", "a", "b")).code, 2);
    assert.match((await cli("--help")).out, /modules new <id>/);
  });

  it("leaves the other commands as they were", async () => {
    assert.equal((await cli("modules", "list", "--dir", work)).code, 2, "--dir applies to modules new only");
  });
});
