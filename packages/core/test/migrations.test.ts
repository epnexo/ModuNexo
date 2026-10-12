import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { checksum, planMigrations, readMigrationFiles } from "../src/migrations.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "epnexo-migrations-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (name: string, sql = "select 1;") => writeFileSync(join(dir, name), sql);

describe("checksum", () => {
  it("is a stable sha256 hex digest of the content", () => {
    assert.equal(checksum("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert.notEqual(checksum("a"), checksum("b"));
  });
});

describe("readMigrationFiles", () => {
  it("returns files ordered by name with their checksum and content", () => {
    write("0002_second.sql", "select 2;");
    write("0001_first.sql", "select 1;");
    const files = readMigrationFiles(dir);
    assert.deepEqual(files.map((f) => f.filename), ["0001_first.sql", "0002_second.sql"]);
    assert.equal(files[0]?.checksum, checksum("select 1;"));
    assert.equal(files[0]?.sql, "select 1;");
  });

  it("returns an empty list when the directory has no migrations", () => {
    assert.deepEqual(readMigrationFiles(dir), []);
  });

  it("ignores files that are not .sql", () => {
    write("0001_first.sql");
    writeFileSync(join(dir, "README.md"), "notes");
    assert.equal(readMigrationFiles(dir).length, 1);
  });

  it("ignores subdirectories", () => {
    write("0001_first.sql");
    mkdirSync(join(dir, "0002_dir.sql"));
    assert.equal(readMigrationFiles(dir).length, 1);
  });

  it("rejects .sql files that do not follow NNNN_name.sql", () => {
    write("first.sql");
    assert.throws(() => readMigrationFiles(dir), /"first\.sql" does not match NNNN_name\.sql/);
  });

  it("rejects two files that share a sequence number", () => {
    write("0001_a.sql");
    write("0001_b.sql");
    assert.throws(() => readMigrationFiles(dir), /duplicate migration number 0001/);
  });

  it("fails clearly when the directory does not exist", () => {
    assert.throws(() => readMigrationFiles(join(dir, "missing")), /migrations directory .* does not exist/);
  });
});

describe("planMigrations", () => {
  const file = (filename: string, sql: string) => ({ filename, sql, checksum: checksum(sql) });

  it("marks files that were never applied as pending, in order", () => {
    const files = [file("0001_a.sql", "a"), file("0002_b.sql", "b")];
    const plan = planMigrations(files, new Map([["0001_a.sql", checksum("a")]]));
    assert.deepEqual(plan.map((f) => f.filename), ["0002_b.sql"]);
  });

  it("returns nothing when everything is applied", () => {
    const files = [file("0001_a.sql", "a")];
    assert.deepEqual(planMigrations(files, new Map([["0001_a.sql", checksum("a")]])), []);
  });

  it("fails loudly when an applied file changed", () => {
    const files = [file("0001_a.sql", "edited")];
    assert.throws(
      () => planMigrations(files, new Map([["0001_a.sql", checksum("original")]])),
      /migration "0001_a\.sql" was modified after it was applied/,
    );
  });

  it("fails when an applied file is missing from disk", () => {
    assert.throws(
      () => planMigrations([], new Map([["0001_a.sql", checksum("a")]])),
      /migration "0001_a\.sql" was applied but is missing/,
    );
  });

  it("fails when a new file sorts before one already applied", () => {
    const files = [file("0001_a.sql", "a"), file("0002_b.sql", "b")];
    assert.throws(
      () => planMigrations(files, new Map([["0002_b.sql", checksum("b")]])),
      /migration "0001_a\.sql" is older than the latest applied migration/,
    );
  });
});
