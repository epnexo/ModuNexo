import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import type { DbQueryable } from "@modunexo/sdk";
import { DiskStorage, FileError, FileService } from "../src/files/index.ts";
import { migrate } from "../src/runner.ts";
import { createPool } from "../src/pool.ts";
import { createScratchDatabase } from "../src/testing.ts";
import { Sandbox } from "./sandbox.ts";

let pool: pg.Pool | undefined;
let skipReason: string | undefined;
let dropScratch: (() => Promise<void>) | undefined;
let box: Sandbox;
let dir: string;
let storage: DiskStorage;
let service: FileService;
let docsId: string;
let plainId: string;
let offId: string;
let otherId: string;
let clock = new Date();

const ascii = (text: string) => new TextEncoder().encode(text);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const text = async (stream: ReadableStream<Uint8Array>) => Buffer.from(await new Response(stream).arrayBuffer());

before(async () => {
  const scratch = await createScratchDatabase();
  if (!scratch.url) {
    skipReason = scratch.skipReason;
    return;
  }
  dropScratch = scratch.drop;
  pool = createPool(scratch.url);
  dir = await mkdtemp(join(tmpdir(), "modunexo-files-svc-"));
  storage = new DiskStorage(join(dir, "files"));
  box = new Sandbox(pool);
  const docs = box.add();
  docsId = docs.manifest.id;
  docs.manifest.files = { maxBytes: 1024, accept: ["image/png", "text/*"] };
  const plain = box.add();
  plainId = plain.manifest.id;
  const off = box.add();
  offId = off.manifest.id;
  off.manifest.files = {};
  const other = box.add();
  otherId = other.manifest.id;
  other.manifest.files = {};
  await migrate(pool, box.registry());
  service = new FileService(pool, box.registry(), storage, { now: () => clock });
});

const wipe = async () => {
  await pool!.query("delete from core.files");
  await pool!.query("delete from core.modules where id = any($1)", [[docsId, plainId, offId, otherId]]);
  for (const [id, state] of [[docsId, "enabled"], [plainId, "enabled"], [offId, "disabled"], [otherId, "enabled"]]) {
    await pool!.query("insert into core.modules (id, state, installed_version) values ($1, $2, '1.0.0')", [id, state]);
  }
  for (const id of [docsId, plainId, offId, otherId]) await storage.removePrefix(id);
  await storage.removePrefix(".tmp");
  clock = new Date();
};
const rows = async () => (await pool!.query("select * from core.files order by created_at, id")).rows;
const keys = async () => {
  const found: string[] = [];
  for await (const entry of storage.list()) found.push(entry.key);
  return found.sort();
};

after(async () => {
  if (pool) {
    await pool.query("delete from core.files").catch(() => undefined);
    await box.cleanup().catch(() => undefined);
    await pool.end();
  }
  await dropScratch?.();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("FileService.put", { concurrency: false }, () => {
  it("stores the bytes and a row, and returns the metadata", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    const meta = await service.put(docsId, { name: "hello.txt", data: ascii("hello world"), ref: "message:42" }, {});
    assert.match(meta.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(meta.name, "hello.txt");
    assert.equal(meta.contentType, "text/plain");
    assert.equal(meta.size, 11);
    assert.equal(meta.sha256, createHash("sha256").update("hello world").digest("hex"));
    assert.equal(meta.ref, "message:42");
    assert.equal(meta.createdAt, clock.toISOString());
    const stored = await rows();
    assert.equal(stored.length, 1);
    assert.deepEqual([stored[0].id, stored[0].module_id, stored[0].name, stored[0].content_type, Number(stored[0].size), stored[0].sha256, stored[0].ref], [
      meta.id, docsId, "hello.txt", "text/plain", 11, meta.sha256, "message:42",
    ]);
    assert.deepEqual(await keys(), [`${docsId}/${meta.id.slice(0, 2)}/${meta.id}`]);
  });

  it("takes bytes, a web stream and an async iterable alike", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    const a = await service.put(docsId, { name: "a.txt", data: ascii("one") }, {});
    const b = await service.put(docsId, { name: "b.txt", data: new Response("two").body! }, {});
    async function* three() {
      yield ascii("th");
      yield ascii("ree");
    }
    const c = await service.put(docsId, { name: "c.txt", data: three() }, {});
    assert.deepEqual([a.size, b.size, c.size], [3, 3, 5]);
    assert.equal((await text((await service.get(docsId, c.id))!.stream)).toString(), "three");
  });

  it("decides the type from the bytes, not from the name", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    const html = await service.put(docsId, { name: "photo.png", data: ascii("<script>alert(1)</script>") }, {});
    assert.equal(html.contentType, "text/plain");
    const png = await service.put(docsId, { name: "notes.txt", data: PNG }, {});
    assert.equal(png.contentType, "image/png");
  });

  it("reduces the name to something safe and keeps nothing of it in the path", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    const meta = await service.put(docsId, { name: "../../etc/pass\u0000wd‮", data: ascii("x") }, {});
    assert.ok(!/[\\/\u0000‮]/.test(meta.name), meta.name);
    assert.equal((await rows())[0].name, meta.name);
    const empty = await service.put(docsId, { name: "..", data: ascii("x") }, {});
    assert.equal(empty.name, "file");
    for (const key of await keys()) assert.match(key, /^[^/]+\/[0-9a-f]{2}\/[0-9a-f-]{36}$/);
  });

  it("refuses a module that is unknown, declares no files, is not enabled, and stores nothing", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    const put = (moduleId: string) => service.put(moduleId, { name: "a.txt", data: ascii("x") }, {});
    await assert.rejects(() => put("nobody"), (e) => e instanceof FileError && /not registered/.test(e.message));
    await assert.rejects(() => put(plainId), (e) => e instanceof FileError && /does not declare files/.test(e.message));
    await assert.rejects(() => put(offId), (e) => e instanceof FileError && /not enabled/.test(e.message));
    assert.equal((await rows()).length, 0);
    assert.deepEqual(await keys(), []);
  });

  it("refuses an empty body, a bad name and a bad ref", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    await assert.rejects(() => service.put(docsId, { name: "a.txt", data: new Uint8Array(0) }, {}), (e) => e instanceof FileError && /empty/.test(e.message));
    await assert.rejects(() => service.put(docsId, { name: 5 as never, data: ascii("x") }, {}), (e) => e instanceof FileError && /name/.test(e.message));
    await assert.rejects(() => service.put(docsId, { name: "a", data: ascii("x"), ref: "r".repeat(201) }, {}), (e) => e instanceof FileError && /ref/.test(e.message));
    await assert.rejects(() => service.put(docsId, { name: "a", data: ascii("x"), ref: 5 as never }, {}), (e) => e instanceof FileError && /ref/.test(e.message));
    await assert.rejects(() => service.put(docsId, { name: "a", data: "text" as never }, {}), (e) => e instanceof FileError && /data/.test(e.message));
    assert.equal((await rows()).length, 0);
    assert.deepEqual(await keys(), []);
  });

  it("stops reading at the module's limit and leaves nothing behind", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    let produced = 0;
    async function* endless() {
      for (;;) {
        produced += 512;
        yield new Uint8Array(512).fill(97);
      }
    }
    await assert.rejects(() => service.put(docsId, { name: "big.txt", data: endless() }, {}), (e) => e instanceof FileError && /over the limit of 1024 bytes/.test(e.message));
    assert.ok(produced <= 1024 + 512 * 4, `read ${produced} bytes`);
    const exact = await service.put(docsId, { name: "exact.txt", data: new Uint8Array(1024).fill(97) }, {});
    assert.equal(exact.size, 1024);
    await assert.rejects(() => service.put(docsId, { name: "over.txt", data: new Uint8Array(1025).fill(97) }, {}), FileError);
    assert.equal((await rows()).length, 1);
    assert.equal((await keys()).length, 1);
  });

  it("refuses a type the module does not accept", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    await assert.rejects(() => service.put(docsId, { name: "x.pdf", data: ascii("%PDF-1.7 body") }, {}), (e) => e instanceof FileError && /application\/pdf/.test(e.message));
    await assert.rejects(() => service.put(docsId, { name: "x.bin", data: Uint8Array.from([0, 1, 2]) }, {}), (e) => e instanceof FileError && /application\/octet-stream/.test(e.message));
    assert.equal((await rows()).length, 0);
    assert.deepEqual(await keys(), []);
  });

  it("uses the default limit when the module declares none", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    const meta = await service.put(otherId, { name: "big.bin", data: new Uint8Array(2 * 1024 * 1024) }, {});
    assert.equal(meta.size, 2 * 1024 * 1024);
  });

  it("writes the row in the caller's transaction: rolled back, no row, and the bytes are left for the sweep", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    const client = await pool!.connect();
    try {
      await client.query("begin");
      await service.put(docsId, { name: "a.txt", data: ascii("inside") }, { tx: client as unknown as DbQueryable });
      await client.query("rollback");
    } finally {
      client.release();
    }
    assert.equal((await rows()).length, 0);
    assert.equal((await keys()).length, 1);
    clock = new Date(Date.now() + 2 * 24 * 3600 * 1000);
    assert.equal((await service.sweep()).removed, 1);
    assert.deepEqual(await keys(), []);
  });

  it("keeps the row when the caller's transaction commits", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    const client = await pool!.connect();
    try {
      await client.query("begin");
      await service.put(docsId, { name: "a.txt", data: ascii("inside") }, { tx: client as unknown as DbQueryable });
      await client.query("commit");
    } finally {
      client.release();
    }
    assert.equal((await rows()).length, 1);
  });

  it("removes the bytes when the row cannot be written", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    const failing = {
      query: async (sql: string) => {
        if (/insert into core\.files/i.test(sql)) throw new Error("insert refused");
        return { rows: [{ ok: 1 }], rowCount: 1 };
      },
    };
    await assert.rejects(() => service.put(docsId, { name: "a.txt", data: ascii("x") }, { tx: failing as unknown as DbQueryable }), /insert refused/);
    assert.deepEqual(await keys(), []);
  });
});

describe("FileService reads", { concurrency: false }, () => {
  it("gets the metadata and the bytes of the module's own file", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    const meta = await service.put(docsId, { name: "a.txt", data: ascii("the bytes") }, {});
    const found = await service.get(docsId, meta.id);
    assert.deepEqual(found?.meta, meta);
    assert.equal((await text(found!.stream)).toString(), "the bytes");
    assert.deepEqual(await service.stat(docsId, meta.id), meta);
  });

  it("answers null for an unknown id, a malformed id and another module's file", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    const meta = await service.put(docsId, { name: "a.txt", data: ascii("x") }, {});
    for (const id of ["00000000-0000-4000-8000-000000000000", "nope", "", "../x", `${meta.id}'`]) {
      assert.equal(await service.get(docsId, id), null, id);
      assert.equal(await service.stat(docsId, id), null, id);
    }
    assert.equal(await service.get(otherId, meta.id), null);
    assert.equal(await service.stat(otherId, meta.id), null);
  });

  it("answers null when the row is there but the bytes are gone", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    const meta = await service.put(docsId, { name: "a.txt", data: ascii("x") }, {});
    await storage.remove(`${docsId}/${meta.id.slice(0, 2)}/${meta.id}`);
    assert.equal(await service.get(docsId, meta.id), null);
    assert.deepEqual(await service.stat(docsId, meta.id), meta);
  });

  it("lists a module's files newest first, by ref, with a clamped limit", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    const made = [];
    for (const [name, ref] of [["a.txt", "m:1"], ["b.txt", "m:2"], ["c.txt", "m:1"]] as const) {
      clock = new Date(clock.getTime() + 1000);
      made.push(await service.put(docsId, { name, data: ascii(name), ref }, {}));
    }
    await service.put(otherId, { name: "z.txt", data: ascii("z"), ref: "m:1" }, {});
    assert.deepEqual((await service.list(docsId, {})).map((f) => f.name), ["c.txt", "b.txt", "a.txt"]);
    assert.deepEqual((await service.list(docsId, { ref: "m:1" })).map((f) => f.name), ["c.txt", "a.txt"]);
    assert.deepEqual((await service.list(docsId, { limit: 2 })).map((f) => f.name), ["c.txt", "b.txt"]);
    assert.equal((await service.list(docsId, { limit: 0 })).length, 1);
    assert.equal((await service.list(docsId, { limit: 100000 })).length, 3);
    assert.deepEqual(await service.list(docsId, { ref: "none" }), []);
    assert.deepEqual((await service.list(docsId, {}))[2], made[0]);
  });
});

describe("FileService.remove", { concurrency: false }, () => {
  it("deletes the row and the bytes", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    const meta = await service.put(docsId, { name: "a.txt", data: ascii("x") }, {});
    assert.equal(await service.remove(docsId, meta.id), true);
    assert.equal((await rows()).length, 0);
    assert.deepEqual(await keys(), []);
    assert.equal(await service.remove(docsId, meta.id), false);
  });

  it("does not touch another module's file or a malformed id", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    const meta = await service.put(docsId, { name: "a.txt", data: ascii("x") }, {});
    assert.equal(await service.remove(otherId, meta.id), false);
    assert.equal(await service.remove(docsId, "nope"), false);
    assert.equal((await rows()).length, 1);
    assert.equal((await keys()).length, 1);
  });

  it("still deletes the row when the bytes are already gone", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    const meta = await service.put(docsId, { name: "a.txt", data: ascii("x") }, {});
    await storage.remove(`${docsId}/${meta.id.slice(0, 2)}/${meta.id}`);
    assert.equal(await service.remove(docsId, meta.id), true);
    assert.equal((await rows()).length, 0);
  });
});

describe("FileService.sweep", { concurrency: false }, () => {
  it("removes old bytes without a row and old temporary files, and keeps the rest", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    const kept = await service.put(docsId, { name: "kept.txt", data: ascii("kept") }, {});
    async function* one() {
      yield ascii("x");
    }
    await storage.write(`${docsId}/00/00000000-0000-4000-8000-00000000000a`, one());
    await storage.write(".tmp/old-upload", one());
    const keptKeys = await keys();
    assert.equal(keptKeys.length, 3);

    clock = new Date(Date.now() + 30 * 60 * 1000);
    assert.deepEqual(await service.sweep(), { removed: 0 });
    assert.equal((await keys()).length, 3);

    clock = new Date(Date.now() + 2 * 3600 * 1000);
    assert.deepEqual(await service.sweep(), { removed: 1 });
    assert.ok(!(await keys()).includes(".tmp/old-upload"));

    clock = new Date(Date.now() + 2 * 24 * 3600 * 1000);
    assert.deepEqual(await service.sweep(), { removed: 1 });
    assert.deepEqual(await keys(), [`${docsId}/${kept.id.slice(0, 2)}/${kept.id}`]);
    assert.equal((await rows()).length, 1);
  });

  it("leaves alone anything that does not look like a file of ours", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    async function* one() {
      yield ascii("x");
    }
    await storage.write(`${docsId}/aa/not-a-uuid`, one());
    clock = new Date(Date.now() + 5 * 24 * 3600 * 1000);
    assert.deepEqual(await service.sweep(), { removed: 0 });
    assert.equal((await keys()).length, 1);
  });
});

describe("FileService.removeModuleBytes", { concurrency: false }, () => {
  it("removes every byte of the module and no other module's", async (t) => {
    if (skipReason) return t.skip(skipReason);
    await wipe();
    await service.put(docsId, { name: "a.txt", data: ascii("1") }, {});
    await service.put(otherId, { name: "b.txt", data: ascii("2") }, {});
    await service.removeModuleBytes(docsId);
    const left = await keys();
    assert.equal(left.length, 1);
    assert.ok(left[0]!.startsWith(`${otherId}/`));
    await assert.rejects(() => service.removeModuleBytes("../x"), FileError);
  });
});
