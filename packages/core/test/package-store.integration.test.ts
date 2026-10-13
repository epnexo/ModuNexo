import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import { DATA_DIR, archivePath, assertSha256, stagingPath } from "../src/packages/paths.ts";
import { listIntakes, recordIntake } from "../src/packages/store.ts";
import { Registry } from "../src/registry.ts";
import { migrate } from "../src/runner.ts";
import { openTestPool } from "../src/testing.ts";

const HASH = "a".repeat(64);

describe("package locations", () => {
  it("keeps archives and staging under var/ at the repository root, which is not tracked", () => {
    assert.equal(DATA_DIR, join(fileURLToPath(new URL("../../..", import.meta.url)), "var"));
  });

  it("names an archive and a staging folder by the SHA-256 and nothing else", () => {
    assert.equal(archivePath("/data", HASH), `/data/packages/${HASH}.tgz`);
    assert.equal(stagingPath("/data", HASH), `/data/staging/${HASH}`);
  });

  it("refuses anything that is not 64 lowercase hexadecimal characters, so a name can never be a path", () => {
    for (const bad of ["", "abc", "../etc/passwd", `${HASH}/..`, "A".repeat(64), "g".repeat(64), `${HASH}0`, ` ${HASH}`]) {
      assert.throws(() => assertSha256(bad), /SHA-256/, JSON.stringify(bad));
      assert.throws(() => archivePath("/data", bad), /SHA-256/);
      assert.throws(() => stagingPath("/data", bad), /SHA-256/);
    }
    assert.doesNotThrow(() => assertSha256(HASH));
  });
});

let pool: pg.Pool | undefined;
let skipReason: string | undefined;

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
    await pool.query("delete from core.module_packages where sha256 like 'a%' or module_id like 'pkgtest-%'");
    await pool.end();
  }
});

const test = (name: string, run: () => Promise<void>) =>
  it(name, async (t) => {
    if (!pool) return t.skip(skipReason);
    await pool.query("delete from core.module_packages where module_id like 'pkgtest-%' or sha256 = $1", [HASH]);
    await run();
  });

describe("core.module_packages (migration 0006)", () => {
  test("records a staged intake and lists it back, newest first", async () => {
    await recordIntake(pool!, { sha256: HASH, moduleId: "pkgtest-a", version: "1.0.0", sizeBytes: 1234, status: "staged", problems: null, actor: "cli" });
    await recordIntake(pool!, { sha256: HASH, moduleId: "pkgtest-a", version: "1.0.0", sizeBytes: 1234, status: "staged", problems: null, actor: "ada@example.test" });
    const rows = await listIntakes(pool!, { moduleId: "pkgtest-a" });
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.actor, "ada@example.test");
    assert.deepEqual({ ...rows[1]!, id: undefined, receivedAt: undefined }, {
      id: undefined,
      sha256: HASH,
      moduleId: "pkgtest-a",
      version: "1.0.0",
      sizeBytes: 1234,
      status: "staged",
      problems: null,
      actor: "cli",
      receivedAt: undefined,
    });
  });

  test("records a refusal with every problem, and a package whose manifest could not be read at all", async () => {
    await recordIntake(pool!, { sha256: HASH, moduleId: null, version: null, sizeBytes: 99, status: "refused", problems: ["a", "b"], actor: "cli" });
    const [row] = await listIntakes(pool!, { sha256: HASH });
    assert.equal(row!.status, "refused");
    assert.deepEqual(row!.problems, ["a", "b"]);
    assert.equal(row!.moduleId, null);
  });

  test("accepts only the two known statuses and a SHA-256 that is 64 hex characters", async () => {
    await assert.rejects(pool!.query("insert into core.module_packages (sha256, size_bytes, status, actor) values ($1, 1, 'installed', 'x')", [HASH]), /check constraint/);
    await assert.rejects(pool!.query("insert into core.module_packages (sha256, size_bytes, status, actor) values ('../x', 1, 'staged', 'x')", []), /check constraint/);
  });

  test("a refused row must say why, and a staged one must not carry problems", async () => {
    await assert.rejects(pool!.query("insert into core.module_packages (sha256, size_bytes, status, actor) values ($1, 1, 'refused', 'x')", [HASH]), /check constraint/);
    await assert.rejects(pool!.query("insert into core.module_packages (sha256, size_bytes, status, problems, actor) values ($1, 1, 'staged', '[\"x\"]'::jsonb, 'x')", [HASH]), /check constraint/);
  });

  test("limits a listing", async () => {
    for (let i = 0; i < 5; i++) await recordIntake(pool!, { sha256: HASH, moduleId: "pkgtest-b", version: "1.0.0", sizeBytes: i, status: "staged", problems: null, actor: "cli" });
    assert.equal((await listIntakes(pool!, { moduleId: "pkgtest-b", limit: 3 })).length, 3);
  });
});
