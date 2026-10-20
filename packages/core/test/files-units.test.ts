import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, utimes, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { DiskStorage, acceptsType, safeFileName, sniffContentType } from "../src/files/index.ts";

const bytes = (...values: number[]) => Uint8Array.from(values);
const ascii = (text: string) => new TextEncoder().encode(text);

describe("sniffContentType", () => {
  it("recognises the known formats from their first bytes", () => {
    assert.equal(sniffContentType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0), false), "image/png");
    assert.equal(sniffContentType(bytes(0xff, 0xd8, 0xff, 0xe0, 0), false), "image/jpeg");
    assert.equal(sniffContentType(ascii("GIF89a\x01\x00"), false), "image/gif");
    assert.equal(sniffContentType(ascii("GIF87a\x01\x00"), false), "image/gif");
    assert.equal(sniffContentType(ascii("RIFF\x10\x00\x00\x00WEBPVP8 "), false), "image/webp");
    assert.equal(sniffContentType(ascii("%PDF-1.7\n"), false), "application/pdf");
    assert.equal(sniffContentType(bytes(0x50, 0x4b, 0x03, 0x04, 0), false), "application/zip");
    assert.equal(sniffContentType(bytes(0x1f, 0x8b, 0x08, 0), false), "application/gzip");
  });

  it("calls readable UTF-8 text plain text, whatever it says it is", () => {
    assert.equal(sniffContentType(ascii("hello\nworld\t!\r\n"), false), "text/plain");
    assert.equal(sniffContentType(new TextEncoder().encode("¿Qué tal? 日本語"), false), "text/plain");
    assert.equal(sniffContentType(ascii("<!doctype html><script>alert(1)</script>"), false), "text/plain");
    assert.equal(sniffContentType(ascii("<svg xmlns='http://www.w3.org/2000/svg'><script/></svg>"), false), "text/plain");
  });

  it("does not take a text cut in the middle of a character for binary", () => {
    const whole = new TextEncoder().encode("añ日");
    const cut = whole.slice(0, whole.length - 1);
    assert.equal(sniffContentType(cut, true), "text/plain");
    assert.equal(sniffContentType(cut, false), "application/octet-stream");
  });

  it("calls everything else a stream of bytes", () => {
    assert.equal(sniffContentType(bytes(0, 1, 2, 3), false), "application/octet-stream");
    assert.equal(sniffContentType(ascii("text\0with nul"), false), "application/octet-stream");
    assert.equal(sniffContentType(bytes(0xc3, 0x28), false), "application/octet-stream");
    assert.equal(sniffContentType(ascii("a\x07b"), false), "application/octet-stream");
    assert.equal(sniffContentType(new Uint8Array(0), false), "application/octet-stream");
    assert.equal(sniffContentType(ascii("RIFF\x10\x00\x00\x00WAVEfmt "), false), "application/octet-stream");
  });
});

describe("acceptsType", () => {
  it("takes anything when nothing is declared", () => {
    assert.equal(acceptsType(undefined, "application/octet-stream"), true);
  });

  it("matches a type exactly or by family", () => {
    assert.equal(acceptsType(["image/png"], "image/png"), true);
    assert.equal(acceptsType(["image/png"], "image/jpeg"), false);
    assert.equal(acceptsType(["image/*"], "image/jpeg"), true);
    assert.equal(acceptsType(["image/*"], "application/pdf"), false);
    assert.equal(acceptsType(["application/pdf", "image/*"], "application/pdf"), true);
    assert.equal(acceptsType([], "image/png"), false);
  });
});

describe("safeFileName", () => {
  it("keeps an ordinary name", () => {
    assert.equal(safeFileName("report 2026.pdf"), "report 2026.pdf");
    assert.equal(safeFileName("Año nuevo — resumen.txt"), "Año nuevo — resumen.txt");
  });

  it("never lets a separator through", () => {
    for (const name of ["../../etc/passwd", "a\\b\\c.txt", "dir/file", "/abs", "C:\\x\\y"]) {
      const clean = safeFileName(name);
      assert.ok(!/[\\/]/.test(clean), `${name} -> ${clean}`);
    }
    assert.equal(safeFileName("a/b"), "a_b");
  });

  it("drops control, invisible and direction-changing characters", () => {
    assert.equal(safeFileName("a\u0000b\u0007c\nd\re.txt"), "abcde.txt");
    assert.equal(safeFileName("photo\u202egnp.exe"), "photognp.exe");
    assert.equal(safeFileName("a\u200bb"), "ab");
  });

  it("never returns an empty or dot-only name", () => {
    for (const name of ["", "   ", ".", "..", "....", "\u0000", " . . "]) {
      assert.equal(safeFileName(name), "file", JSON.stringify(name));
    }
  });

  it("cuts at 200 characters without splitting a character", () => {
    assert.equal(safeFileName("a".repeat(500)).length, 200);
    const emoji = safeFileName("😀".repeat(300));
    assert.equal(Array.from(emoji).length, 200);
    assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(emoji));
  });
});

describe("DiskStorage", () => {
  let root: string;
  let storage: DiskStorage;
  before(async () => {
    root = await mkdtemp(join(tmpdir(), "modunexo-files-"));
    storage = new DiskStorage(join(root, "files"));
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function* chunks(...parts: string[]): AsyncGenerator<Uint8Array> {
    for (const part of parts) yield ascii(part);
  }
  const read = async (key: string) => {
    const stream = await storage.open(key);
    assert.ok(stream, `${key} should exist`);
    const out: Buffer[] = [];
    for await (const chunk of stream) out.push(Buffer.from(chunk));
    return Buffer.concat(out).toString();
  };

  it("writes what it is given and reads it back", async () => {
    await storage.write("mod-a/ab/file1", chunks("hello ", "world"));
    assert.equal(await read("mod-a/ab/file1"), "hello world");
  });

  it("keeps the bytes private to the platform's user", async () => {
    await storage.write("mod-a/cd/private", chunks("x"));
    const file = await stat(join(root, "files", "mod-a", "cd", "private"));
    assert.equal(file.mode & 0o077, 0);
    const dir = await stat(join(root, "files", "mod-a"));
    assert.equal(dir.mode & 0o077, 0);
  });

  it("answers null for a key that is not there", async () => {
    assert.equal(await storage.open("mod-a/zz/missing"), null);
  });

  it("refuses to overwrite a key", async () => {
    await storage.write("mod-a/ef/once", chunks("first"));
    await assert.rejects(() => storage.write("mod-a/ef/once", chunks("second")));
    assert.equal(await read("mod-a/ef/once"), "first");
  });

  it("leaves nothing behind when the source fails halfway", async () => {
    async function* broken(): AsyncGenerator<Uint8Array> {
      yield ascii("part");
      throw new Error("boom");
    }
    await assert.rejects(() => storage.write("mod-a/12/broken", broken()), /boom/);
    assert.equal(await storage.open("mod-a/12/broken"), null);
  });

  it("moves a key and removes one, and removing a missing key is not an error", async () => {
    await storage.write(".tmp/t1", chunks("moved"));
    await storage.move(".tmp/t1", "mod-a/34/final");
    assert.equal(await storage.open(".tmp/t1"), null);
    assert.equal(await read("mod-a/34/final"), "moved");
    await storage.remove("mod-a/34/final");
    await storage.remove("mod-a/34/final");
    assert.equal(await storage.open("mod-a/34/final"), null);
  });

  it("refuses a move onto a key that exists", async () => {
    await storage.write(".tmp/t2", chunks("new"));
    await storage.write("mod-a/56/taken", chunks("old"));
    await assert.rejects(() => storage.move(".tmp/t2", "mod-a/56/taken"));
    assert.equal(await read("mod-a/56/taken"), "old");
  });

  it("refuses a key that could leave its folder", async () => {
    const bad = ["", "..", "../x", "a/../../x", "/abs", "a//b", "a/./b", "a\\b", "a/b/", ".hidden/x", "a/\u0000b", "a/b c", "x".repeat(300)];
    for (const key of bad) {
      await assert.rejects(() => storage.write(key, chunks("x")), /key/, JSON.stringify(key));
      await assert.rejects(() => storage.open(key), /key/, JSON.stringify(key));
      await assert.rejects(() => storage.remove(key), /key/, JSON.stringify(key));
      await assert.rejects(() => storage.move(key, "mod-a/78/x"), /key/, JSON.stringify(key));
    }
    await assert.rejects(() => storage.removePrefix("../x"), /key/);
    await assert.rejects(() => storage.removePrefix(""), /key/);
  });

  it("lists every key with when it was last written", async () => {
    await storage.write("mod-b/aa/l1", chunks("1"));
    await storage.write(".tmp/l2", chunks("2"));
    const old = new Date("2020-01-01T00:00:00Z");
    await utimes(join(root, "files", "mod-b", "aa", "l1"), old, old);
    const seen = new Map<string, Date>();
    for await (const entry of storage.list()) seen.set(entry.key, entry.modifiedAt);
    assert.equal(seen.get("mod-b/aa/l1")?.getTime(), old.getTime());
    assert.ok(seen.has(".tmp/l2"));
    assert.ok(seen.has("mod-a/ab/file1"));
  });

  it("removes everything under a prefix and nothing else", async () => {
    await storage.write("mod-c/aa/x", chunks("1"));
    await storage.write("mod-c/bb/y", chunks("2"));
    await storage.write("mod-cc/aa/z", chunks("3"));
    await storage.removePrefix("mod-c");
    assert.equal(await storage.open("mod-c/aa/x"), null);
    assert.equal(await storage.open("mod-c/bb/y"), null);
    assert.equal(await read("mod-cc/aa/z"), "3");
    await storage.removePrefix("mod-c");
  });

  it("does not follow a symbolic link out of its folder", async () => {
    const outside = join(root, "outside.txt");
    await writeFile(outside, "secret");
    await mkdir(join(root, "files", "mod-d"), { recursive: true });
    const { symlink } = await import("node:fs/promises");
    await symlink(outside, join(root, "files", "mod-d", "link"));
    assert.equal(await storage.open("mod-d/link"), null);
    const listed: string[] = [];
    for await (const entry of storage.list()) listed.push(entry.key);
    assert.ok(!listed.includes("mod-d/link"));
    await storage.removePrefix("mod-d");
    assert.equal((await readFile(outside)).toString(), "secret");
  });
});
