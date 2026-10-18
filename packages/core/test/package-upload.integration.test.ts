import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SDK_VERSION } from "@modunexo/sdk";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type pg from "pg";
import { UploadTooLargeError, receiveUpload } from "../src/packages/upload.ts";
import type { PackageContext } from "../src/packages/validate.ts";
import { Registry } from "../src/registry.ts";
import { migrate } from "../src/runner.ts";
import { openTestPool } from "../src/testing.ts";
import { packageEntries } from "./helpers/package-fixture.ts";
import { tgz } from "./helpers/tarball.ts";

let pool: pg.Pool | undefined;
let skipReason: string | undefined;
let work: string;
const ACTOR = "upload-test";

before(async () => {
  ({ pool, skipReason } = await openTestPool());
  if (pool) {
    const registry = new Registry();
    registry.registerCore();
    await migrate(pool, registry);
  }
});
after(async () => {
  if (pool) {
    await pool.query("delete from core.module_packages where actor = $1", [ACTOR]);
    await pool.end();
  }
});
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "modunexo-upload-"));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

const context: PackageContext = { sdkVersion: SDK_VERSION, installedVersion: () => null, modules: new Map(), modulePackages: new Map() };

const test = (name: string, run: () => Promise<void>) =>
  it(name, async (t) => {
    if (!pool) return t.skip(skipReason);
    await run();
  });

/** A web stream that yields the bytes in pieces, as a request body does. */
const streamOf = (bytes: Uint8Array, piece = 4096) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (let at = 0; at < bytes.length; at += piece) controller.enqueue(bytes.subarray(at, Math.min(bytes.length, at + piece)));
      controller.close();
    },
  });
const leftovers = () => (existsSync(join(work, "uploads")) ? readdirSync(join(work, "uploads")) : []);
const receive = (body: ReadableStream<Uint8Array>, extra: { expectedSha256?: string; maxBytes?: number } = {}) =>
  receiveUpload({ pool: pool!, body, dataDir: work, context, actor: ACTOR, ...extra });

describe("receiveUpload", () => {
  test("a good archive is stored, reviewed and recorded, and no upload file is left", async () => {
    const result = await receive(streamOf(tgz(packageEntries({ id: "upl-one" }))));
    assert.equal(result.ok, true, JSON.stringify(result));
    if (result.ok) {
      assert.equal(result.review.id, "upl-one");
      assert.ok(existsSync(result.archiveFile));
    }
    assert.deepEqual(leftovers(), []);
  });

  test("a body over the limit is refused as soon as it passes it, and nothing is kept", async () => {
    const big = new Uint8Array(10_000);
    await assert.rejects(receive(streamOf(big, 1000), { maxBytes: 4096 }), UploadTooLargeError);
    assert.deepEqual(leftovers(), []);
    assert.equal(existsSync(join(work, "packages")), false, "it never reached intake");
  });

  test("an archive that is not a package is a refusal with its problems", async () => {
    const result = await receive(streamOf(new TextEncoder().encode("not an archive at all")));
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.problems.length > 0);
    assert.deepEqual(leftovers(), []);
  });

  test("the SHA-256 the sender gave must match", async () => {
    const result = await receive(streamOf(tgz(packageEntries({ id: "upl-two" }))), { expectedSha256: "f".repeat(64) });
    assert.equal(result.ok, false);
    assert.deepEqual(leftovers(), []);
  });

  test("a stream that fails half way leaves nothing behind", async () => {
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(100));
        controller.error(new Error("connection reset"));
      },
    });
    await assert.rejects(receive(failing), /connection reset/);
    assert.deepEqual(leftovers(), []);
  });
});
