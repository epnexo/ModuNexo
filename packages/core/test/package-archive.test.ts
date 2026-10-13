import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ARCHIVE_LIMITS, inspectArchive, stageArchive } from "../src/packages/archive.ts";
import { type TarEntry, tgz } from "./helpers/tarball.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "epnexo-archive-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const archive = (entries: TarEntry[], name = "module.tgz") => {
  const file = join(dir, name);
  writeFileSync(file, tgz(entries));
  return file;
};

const GOOD: TarEntry[] = [
  { name: "package/", type: "5" },
  { name: "package/package.json", data: '{"name":"@x/y"}' },
  { name: "package/migrations/", type: "5" },
  { name: "package/migrations/0001_init.sql", data: "create table t (id int);" },
  { name: "package/web/page.tsx", data: "export default () => null;" },
];

const problemsOf = async (entries: TarEntry[], limits = {}) => {
  const result = await inspectArchive(archive(entries), { ...ARCHIVE_LIMITS, ...limits });
  assert.equal(result.ok, false, "expected the archive to be refused");
  return result.ok ? "" : result.problems.join("\n");
};

describe("inspectArchive: what it accepts", () => {
  it("lists a well formed package and names its single top-level folder", async () => {
    const result = await inspectArchive(archive(GOOD));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.root, "package");
    assert.deepEqual(
      result.entries.map((e) => [e.path, e.type]),
      [
        ["package/", "dir"],
        ["package/package.json", "file"],
        ["package/migrations/", "dir"],
        ["package/migrations/0001_init.sql", "file"],
        ["package/web/page.tsx", "file"],
      ],
    );
    assert.equal(result.unpackedBytes, '{"name":"@x/y"}'.length + "create table t (id int);".length + "export default () => null;".length);
  });

  it("accepts a package whose folder has any name, as long as it is the only one", async () => {
    const result = await inspectArchive(archive([{ name: "my-module-1.0.0/package.json", data: "{}" }]));
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.root, "my-module-1.0.0");
  });
});

describe("inspectArchive: what it refuses", () => {
  it("an absolute path, a parent segment and a dot segment", async () => {
    assert.match(await problemsOf([{ name: "/etc/passwd", data: "x" }]), /absolute/);
    assert.match(await problemsOf([{ name: "package/../evil.txt", data: "x" }]), /"\.\."/);
    assert.match(await problemsOf([{ name: "package/./a.txt", data: "x" }]), /"\."/);
    assert.match(await problemsOf([{ name: "C:/Windows/x", data: "x" }]), /absolute|drive/);
  });

  it("backslashes and control characters in a name", async () => {
    assert.match(await problemsOf([{ name: "package\\evil.txt", data: "x" }]), /backslash/);
    assert.match(await problemsOf([{ name: "package/a\u0007b.txt", data: "x" }]), /control/);
  });

  it("links of both kinds, devices and pipes, naming the entry", async () => {
    for (const [type, word] of [["2", "symbolic link"], ["1", "hard link"], ["3", "device"], ["4", "device"], ["6", "special"]] as const) {
      const linkname = type === "1" || type === "2" ? "/etc/passwd" : undefined;
      const problems = await problemsOf([{ name: "package/", type: "5" }, { name: "package/thing", type, ...(linkname === undefined ? {} : { linkname }) }]);
      assert.match(problems, /package\/thing/, type);
      assert.match(problems, new RegExp(word), type);
    }
  });

  it("more than one top-level folder, and files outside any folder", async () => {
    assert.match(await problemsOf([{ name: "one/a.txt", data: "x" }, { name: "two/b.txt", data: "x" }]), /exactly one top-level folder/);
    assert.match(await problemsOf([{ name: "loose.txt", data: "x" }]), /inside a folder/);
  });

  it("the same path twice, also when only the letter case differs", async () => {
    assert.match(await problemsOf([{ name: "package/a.ts", data: "1" }, { name: "package/a.ts", data: "2" }]), /duplicate/);
    assert.match(await problemsOf([{ name: "package/A.ts", data: "1" }, { name: "package/a.ts", data: "2" }]), /duplicate/);
  });

  it("node_modules and .git anywhere in the tree, in any letter case", async () => {
    assert.match(await problemsOf([{ name: "package/node_modules/x/index.js", data: "x" }]), /node_modules/);
    assert.match(await problemsOf([{ name: "package/web/.git/config", data: "x" }]), /\.git/);
    assert.match(await problemsOf([{ name: "package/Node_Modules/x.js", data: "x" }]), /node_modules/i);
  });

  it("a path or a segment longer than the limit", async () => {
    assert.match(await problemsOf([{ name: `package/${"a".repeat(300)}`, data: "x" }]), /too long/);
  });

  it("more files than the limit, and more bytes than the limit once unpacked", async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ name: `package/f${i}.txt`, data: "x" }));
    assert.match(await problemsOf(many, { files: 5 }), /more than 5 entries/);
    assert.match(await problemsOf([{ name: "package/big.bin", data: Buffer.alloc(2000, 1) }], { unpackedBytes: 1000 }), /unpacked size/);
  });

  it("an archive over the size limit, before reading it", async () => {
    const result = await inspectArchive(archive(GOOD), { ...ARCHIVE_LIMITS, archiveBytes: 10 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.problems.join("\n"), /archive is \d+ bytes/);
  });

  it("something that is not a gzip tarball, an empty archive and a truncated one", async () => {
    writeFileSync(join(dir, "plain.txt"), "just text");
    const plain = await inspectArchive(join(dir, "plain.txt"));
    assert.equal(plain.ok, false);
    const empty = await inspectArchive(archive([]));
    assert.equal(empty.ok, false);
    if (!empty.ok) assert.match(empty.problems.join("\n"), /empty/);
    const whole = tgz(GOOD);
    writeFileSync(join(dir, "cut.tgz"), whole.subarray(0, Math.floor(whole.length / 2)));
    const cut = await inspectArchive(join(dir, "cut.tgz"));
    assert.equal(cut.ok, false);
  });

  it("a decompression bomb, quickly and without reading it all into memory", async () => {
    // Forty megabytes of zeros compress to a few kilobytes and are not a tar at all.
    writeFileSync(join(dir, "bomb.tgz"), gzipSync(Buffer.alloc(40 * 1024 * 1024)));
    const started = Date.now();
    const result = await inspectArchive(join(dir, "bomb.tgz"), { ...ARCHIVE_LIMITS, unpackedBytes: 1024 * 1024 });
    assert.equal(result.ok, false);
    assert.ok(Date.now() - started < 5000, "it gave up early");
  });

  it("reports every problem it finds, not only the first", async () => {
    const problems = await problemsOf([{ name: "/abs.txt", data: "x" }, { name: "package/l", type: "2", linkname: "x" }, { name: "package/node_modules/a", data: "x" }]);
    assert.match(problems, /absolute/);
    assert.match(problems, /symbolic link/);
    assert.match(problems, /node_modules/);
  });
});

describe("stageArchive", () => {
  it("unpacks a good archive without its top-level folder, with fixed modes and nothing executable", async () => {
    const entries: TarEntry[] = [
      { name: "package/", type: "5", mode: 0o777 },
      { name: "package/run.sh", data: "#!/bin/sh\necho hi\n", mode: 0o4755 },
      { name: "package/web/page.tsx", data: "export default () => null;", mode: 0o600 },
    ];
    const target = join(dir, "staged");
    const result = await stageArchive(archive(entries), target);
    assert.equal(result.ok, true);
    assert.equal(readFileSync(join(target, "run.sh"), "utf8"), "#!/bin/sh\necho hi\n");
    assert.equal(statSync(join(target, "run.sh")).mode & 0o7777, 0o644, "no setuid, no executable bit");
    assert.equal(statSync(join(target, "web/page.tsx")).mode & 0o7777, 0o644);
    assert.equal(statSync(join(target, "web")).mode & 0o7777, 0o755);
  });

  it("creates nothing at all when the archive is refused", async () => {
    const target = join(dir, "staged");
    const result = await stageArchive(archive([{ name: "package/../evil.txt", data: "x" }]), target);
    assert.equal(result.ok, false);
    assert.equal(existsSync(target), false);
    assert.equal(existsSync(join(dir, "evil.txt")), false);
  });

  it("will not unpack over something that is already there", async () => {
    const target = join(dir, "staged");
    await stageArchive(archive(GOOD), target);
    await assert.rejects(stageArchive(archive(GOOD), target), /already exists/);
  });
});
