import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import { createPool } from "../src/pool.ts";
import { Registry } from "../src/registry.ts";
import { migrate } from "../src/runner.ts";
import { createScratchDatabase } from "../src/testing.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const BACKUP = join(ROOT, "scripts/backup.sh");
const RESTORE = join(ROOT, "scripts/restore.sh");

interface Outcome {
  code: number;
  out: string;
  err: string;
}
const run = (script: string, args: string[]): Promise<Outcome> =>
  new Promise((resolve) => {
    execFile("bash", [script, ...args], { env: { PATH: process.env.PATH, HOME: process.env.HOME, EPNEXO_MASTER_KEY: "m".repeat(40) } }, (error, out, err) => {
      resolve({ code: error === null ? 0 : ((error as { code?: number }).code ?? 1), out, err });
    });
  });

const toolsAvailable = () => run("-c", ['source "$1"; pg_mode', "x", join(ROOT, "scripts/pg-tools.sh")]).then((r) => r.code === 0);

let work: string;
let skipReason: string | undefined;
let source: { url: string; pool: pg.Pool; drop: () => Promise<void> } | undefined;
const extra: Array<() => Promise<void>> = [];

async function scratch(): Promise<{ url: string; pool: pg.Pool }> {
  const db = await createScratchDatabase();
  assert.ok(db.url, db.skipReason);
  const pool = createPool(db.url);
  extra.push(async () => {
    await pool.end();
    await db.drop();
  });
  return { url: db.url, pool };
}
const tableCount = async (pool: pg.Pool) => (await pool.query("select count(*)::int as n from information_schema.tables where table_schema not in ('pg_catalog','information_schema')")).rows[0].n as number;

const put = (root: string, path: string, content: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
};
const backups = (dir: string) => readdirSync(dir).filter((name) => name.startsWith("epnexo-backup-"));

before(async () => {
  work = mkdtempSync(join(tmpdir(), "epnexo-backup-"));
  if (!(await toolsAvailable())) {
    skipReason = "neither PostgreSQL client tools nor the compose db service are available";
    return;
  }
  const db = await scratch();
  if (db.url === undefined) return;
  source = { ...db, drop: async () => undefined };
  const registry = new Registry();
  registry.registerCore();
  await migrate(db.pool, registry);
  await db.pool.query("insert into core.platform_settings (key, value, updated_by) values ('backup.marker', '\"kept\"'::jsonb, 'test')");
});

after(async () => {
  for (const close of extra.reverse()) await close();
  rmSync(work, { recursive: true, force: true });
});

const guard = (name: string, body: () => Promise<void>) =>
  it(name, { timeout: 120_000 }, async (t) => {
    if (skipReason !== undefined || source === undefined) return t.skip(skipReason);
    await body();
  });

describe("backup.sh and restore.sh", () => {
  let made: string;
  const modulesA = () => join(work, "modules-a");
  const dataA = () => join(work, "data-a");

  guard("saves the database, the modules and the packages, readable by the owner only, and not the master key", async () => {
    put(modulesA(), "alpha/manifest.ts", "export default { id: 'alpha' };\n");
    put(modulesA(), "alpha/node_modules/skip/index.js", "no\n");
    put(dataA(), "packages/abc.tgz", "archive bytes");
    put(dataA(), "staging/abc/ignored.txt", "rebuilt on demand");
    const result = await run(BACKUP, ["--out", join(work, "out"), "--database-url", source!.url, "--modules-dir", modulesA(), "--data-dir", dataA()]);
    assert.equal(result.code, 0, result.err);
    made = backups(join(work, "out")).map((name) => join(work, "out", name))[0]!;
    assert.deepEqual(readdirSync(made!).sort(), ["BACKUP_INFO", "SHA256SUMS", "database.dump", "modules.tar.gz", "packages.tar.gz"]);
    for (const name of readdirSync(made!)) assert.equal(statSync(join(made!, name)).mode & 0o077, 0, `${name} is private`);
    assert.equal(statSync(made!).mode & 0o077, 0, "the folder is private");
    const info = readFileSync(join(made!, "BACKUP_INFO"), "utf8");
    assert.match(info, /EPNEXO_MASTER_KEY is not included/);
    for (const name of readdirSync(made!)) assert.ok(!readFileSync(join(made!, name)).includes("m".repeat(40)), `${name} holds no master key`);
  });

  guard("restores into an empty database and empty folders, byte for byte", async () => {
    const target = await scratch();
    const modulesB = join(work, "modules-b");
    const dataB = join(work, "data-b");
    const result = await run(RESTORE, [made!, "--database-url", target.url, "--modules-dir", modulesB, "--data-dir", dataB]);
    assert.equal(result.code, 0, result.err);
    assert.equal(await tableCount(target.pool), await tableCount(source!.pool));
    assert.deepEqual((await target.pool.query("select value from core.platform_settings where key = 'backup.marker'")).rows, [{ value: "kept" }]);
    assert.equal(readFileSync(join(modulesB, "alpha/manifest.ts"), "utf8"), "export default { id: 'alpha' };\n");
    assert.equal(readFileSync(join(dataB, "packages/abc.tgz"), "utf8"), "archive bytes");
    assert.deepEqual(readdirSync(join(modulesB, "alpha")), ["manifest.ts"], "node_modules was left out");
    assert.equal(readdirSync(dataB).includes("staging"), false, "staging is rebuilt, not saved");
  });

  guard("never overwrites: a database that already has tables, or folders that already hold modules, are refused untouched", async () => {
    const full = await scratch();
    const registry = new Registry();
    registry.registerCore();
    await migrate(full.pool, registry);
    const before = await tableCount(full.pool);
    const refusedDb = await run(RESTORE, [made!, "--database-url", full.url, "--modules-dir", join(work, "modules-c"), "--data-dir", join(work, "data-c")]);
    assert.notEqual(refusedDb.code, 0);
    assert.match(refusedDb.err, /already has \d+ tables/);
    assert.equal(await tableCount(full.pool), before);
    assert.equal(readdirSync(work).includes("modules-c"), false, "no folder was created");

    const empty = await scratch();
    const refusedDir = await run(RESTORE, [made!, "--database-url", empty.url, "--modules-dir", join(work, "modules-b"), "--data-dir", join(work, "data-d")]);
    assert.notEqual(refusedDir.code, 0);
    assert.match(refusedDir.err, /already holds modules/);
    assert.equal(await tableCount(empty.pool), 0, "the database was not touched");
  });

  guard("refuses a backup that no longer matches its checksums, before changing anything", async () => {
    const tampered = join(work, "tampered");
    mkdirSync(tampered);
    for (const name of readdirSync(made!)) writeFileSync(join(tampered, name), readFileSync(join(made!, name)));
    writeFileSync(join(tampered, "database.dump"), Buffer.concat([readFileSync(join(made!, "database.dump")), Buffer.from("x")]));
    const target = await scratch();
    const result = await run(RESTORE, [tampered, "--database-url", target.url, "--modules-dir", join(work, "modules-e"), "--data-dir", join(work, "data-e")]);
    assert.notEqual(result.code, 0);
    assert.match(result.err, /SHA256SUMS/);
    assert.equal(await tableCount(target.pool), 0);
  });

  guard("a backup that fails leaves no half-written folder behind", async () => {
    const out = join(work, "out-fail");
    const bad = source!.url.replace(/\/[^/]+$/, "/does_not_exist_test");
    const result = await run(BACKUP, ["--out", out, "--database-url", bad, "--modules-dir", modulesA(), "--data-dir", dataA()]);
    assert.notEqual(result.code, 0);
    assert.deepEqual(backups(out), []);
  });

  guard("is a usage error without a database or with an unknown option", async () => {
    assert.equal((await run(BACKUP, ["--nope"])).code, 2);
    assert.equal((await run(RESTORE, [])).code, 2);
  });
});
