import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SDK_VERSION } from "@modunexo/sdk";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type pg from "pg";
import { intakePackage } from "../src/packages/intake.ts";
import type { PackageContext } from "../src/packages/validate.ts";
import { Registry } from "../src/registry.ts";
import { migrate } from "../src/runner.ts";
import { openTestPool } from "../src/testing.ts";
import { type PackageOptions, packageEntries } from "./helpers/package-fixture.ts";
import { type TarEntry, tgz } from "./helpers/tarball.ts";

let pool: pg.Pool | undefined;
let skipReason: string | undefined;
let work: string;
let dataDir: string;
const MARKER_ID_PREFIX = "intk";

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
    await pool.query("delete from core.module_packages where actor like 'intake-test%'");
    await pool.end();
  }
});

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "modunexo-intake-"));
  dataDir = join(work, "var");
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

const context: PackageContext = {
  sdkVersion: SDK_VERSION,
  installedVersion: (name) => ({ react: "19.3.0" })[name as "react"] ?? null,
  modules: new Map(),
  modulePackages: new Map(),
};

const write = (entries: TarEntry[], name = "module.tgz") => {
  const file = join(work, name);
  writeFileSync(file, tgz(entries));
  return file;
};
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const archive = (options: PackageOptions = {}) => write(packageEntries(options));
const intake = (file: string, extra: { expectedSha256?: string; actor?: string } = {}) =>
  intakePackage({ pool: pool!, archive: file, dataDir, context, actor: extra.actor ?? "intake-test", ...(extra.expectedSha256 === undefined ? {} : { expectedSha256: extra.expectedSha256 }) });
const rows = async (hash: string) => (await pool!.query("select module_id, version, status, problems, actor, size_bytes from core.module_packages where sha256 = $1 order by id", [hash])).rows;
const tree = (path: string): string[] => (existsSync(path) ? readdirSync(path, { recursive: true }).map(String).sort() : []);

const test = (name: string, run: () => Promise<void>) =>
  it(name, async (t) => {
    if (!pool) return t.skip(skipReason);
    await run();
  });

describe("intakePackage: a good archive", () => {
  test("is stored under its SHA-256, unpacked into staging, described and recorded", async () => {
    const file = archive();
    const result = await intake(file);
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.sha256, sha(file));
    assert.equal(result.alreadyStaged, false);
    assert.equal(result.review.id, "reports");
    assert.equal(result.sizeBytes, readFileSync(file).length);
    assert.equal(readFileSync(join(dataDir, "packages", `${result.sha256}.tgz`)).equals(readFileSync(file)), true, "the stored copy is the archive");
    assert.equal(readFileSync(join(dataDir, "staging", result.sha256, "package.json"), "utf8").includes("@acme/reports"), true);
    const recorded = await rows(result.sha256);
    assert.deepEqual(recorded.map((r) => [r.module_id, r.version, r.status, r.problems, r.actor]), [["reports", "1.0.0", "staged", null, "intake-test"]]);
    assert.equal(existsSync(file), true, "the source file is not touched");
  });

  test("a second intake of the same archive is recognised, re-described and recorded again", async () => {
    const file = archive();
    const first = await intake(file);
    assert.equal(first.ok, true);
    const before = (await rows(sha(file))).length;
    const second = await intake(file, { actor: "intake-test-2" });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.alreadyStaged, true);
    const after = await rows(second.sha256);
    assert.equal(after.length, before + 1, "every intake is recorded, repeats included");
    assert.equal(after.at(-1)?.actor, "intake-test-2");
  });

  test("matches an expected SHA-256 in either letter case", async () => {
    const file = archive();
    assert.equal((await intake(file, { expectedSha256: sha(file).toUpperCase() })).ok, true);
  });
});

describe("intakePackage: what it refuses leaves nothing behind", () => {
  test("a SHA-256 that is not the archive's", async () => {
    const file = archive();
    const wrong = "0".repeat(64);
    const result = await intake(file, { expectedSha256: wrong });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.problems.join("\n"), new RegExp(`SHA-256 is ${sha(file)}.*not the expected ${wrong}`));
    assert.deepEqual(tree(dataDir).filter((p) => p.endsWith(".tgz") || p.startsWith("staging/")), []);
    assert.equal((await rows(sha(file))).at(-1)?.status, "refused");
  });

  test("an expected SHA-256 that is not 64 hex characters is an error, not a refusal", async () => {
    await assert.rejects(intake(archive(), { expectedSha256: "nope" }), /SHA-256/);
  });

  test("a hostile archive: nothing is written outside the data folder, nothing is kept inside it", async () => {
    const file = write([{ name: "package/", type: "5" }, { name: "package/../../escaped.txt", data: "x" }, { name: "package/link", type: "2", linkname: "/etc/passwd" }]);
    const result = await intake(file);
    assert.equal(result.ok, false);
    assert.equal(existsSync(join(work, "escaped.txt")), false);
    assert.equal(existsSync(join(dataDir, "..", "escaped.txt")), false);
    assert.deepEqual(tree(dataDir).filter((p) => p.endsWith(".tgz")), [], "the archive copy was removed");
    assert.deepEqual(tree(join(dataDir, "staging")), []);
    assert.equal((await rows(sha(file))).at(-1)?.status, "refused");
  });

  test("a well formed archive that is not a valid package: refused with every problem, staging and copy removed", async () => {
    const file = archive({ files: { "manifest.json": null, "migrations/0001_init.sql": null }, packageJson: { dependencies: { "left-pad": "^1" } } });
    const result = await intake(file);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.problems.join("\n"), /manifest\.json is missing/);
    assert.match(result.problems.join("\n"), /left-pad/);
    assert.deepEqual(tree(join(dataDir, "staging")), []);
    assert.deepEqual(tree(join(dataDir, "packages")), []);
    const recorded = await rows(result.sha256!);
    assert.equal(recorded.at(-1)?.status, "refused");
    assert.deepEqual(recorded.at(-1)?.problems, result.problems);
  });

  test("a refusal records the module's id and version when the manifest could be read, and null when it cannot be trusted", async () => {
    const readable = archive({ id: "billing", version: "2.1.0", packageJson: { dependencies: { "left-pad": "^1" } } }, );
    const refused = await intake(readable);
    assert.equal(refused.ok, false);
    const [row] = (await rows(sha(readable))).slice(-1);
    assert.deepEqual([row!.module_id, row!.version], ["billing", "2.1.0"]);

    const hostile = write(
      packageEntries({ manifest: { id: "../../etc/passwd", version: "not a version" }, packageJson: { name: "@acme/x", version: "1.0.0" } }),
      "hostile.tgz",
    );
    const second = await intake(hostile);
    assert.equal(second.ok, false);
    const [hostileRow] = (await rows(sha(hostile))).slice(-1);
    assert.deepEqual([hostileRow!.module_id, hostileRow!.version], [null, null]);
  });

  test("something that is not an archive at all", async () => {
    writeFileSync(join(work, "plain.txt"), "hello");
    const result = await intake(join(work, "plain.txt"));
    assert.equal(result.ok, false);
    assert.equal((await rows(sha(join(work, "plain.txt")))).at(-1)?.status, "refused");
  });

  test("a file that does not exist is an error", async () => {
    await assert.rejects(intake(join(work, "missing.tgz")), /ENOENT|does not exist/);
  });
});

describe("intakePackage: nothing in the package runs", () => {
  test("not its manifest, its hooks, its page, its migrations, nor an npm script", async () => {
    const marker = join(work, "RAN");
    const code = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\nthrow new Error("must not run");\n`;
    const file = archive({
      manifest: { hooks: "./hooks.ts" },
      files: { "manifest.ts": code, "hooks.ts": code, "web/page.tsx": code, "migrations/0002_boom.sql": "select pg_sleep(60);" },
      packageJson: { scripts: { preinstall: `node -e ${JSON.stringify(code)}`, postinstall: `node -e ${JSON.stringify(code)}`, prepare: "touch RAN" }, main: "./manifest.ts", bin: { x: "./hooks.ts" } },
    });
    const started = Date.now();
    const result = await intake(file);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(existsSync(marker), false, "no code from the package was executed");
    assert.equal(existsSync(join(dataDir, "staging", sha(file), "RAN")), false);
    assert.ok(Date.now() - started < 20_000, "and the migration was not run either");
    if (result.ok) assert.deepEqual(result.review.scripts, ["postinstall", "prepare", "preinstall"].sort());
  });

  test("it does not touch the modules folder or the lifecycle state", async () => {
    const before = (await pool!.query("select count(*)::int as n from core.modules")).rows[0].n;
    await intake(archive({ id: `${MARKER_ID_PREFIX}-one` }));
    assert.equal((await pool!.query("select count(*)::int as n from core.modules")).rows[0].n, before);
  });
});

describe("intakePackage: the same archive, again and at the same time", () => {
  test("concurrent intakes of one new archive all succeed and leave one good staged tree", async () => {
    const file = archive({ id: `${MARKER_ID_PREFIX}-race` });
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => intake(file, { actor: "intake-test-race" })));
    for (const result of results) assert.equal(result.ok, true, JSON.stringify(result));
    const hash = sha(file);
    assert.ok(existsSync(join(dataDir, "staging", hash, "manifest.json")));
    assert.ok(existsSync(join(dataDir, "packages", `${hash}.tgz`)));
    assert.equal((await rows(hash)).filter((row) => row.status === "refused").length, 0);
  });

  test("an already staged package that no longer passes is refused and its files are removed", async () => {
    const file = archive({ id: `${MARKER_ID_PREFIX}-stale`, packageJson: { dependencies: { react: "^19.0.0" } } });
    const first = await intake(file);
    assert.equal(first.ok, true, JSON.stringify(first));
    const hash = sha(file);
    assert.ok(existsSync(join(dataDir, "staging", hash)));

    const later: PackageContext = { ...context, installedVersion: () => null };
    const second = await intakePackage({ pool: pool!, archive: file, dataDir, context: later, actor: "intake-test" });
    assert.equal(second.ok, false);
    assert.equal(existsSync(join(dataDir, "staging", hash)), false, "the staged tree is gone");
    assert.equal(existsSync(join(dataDir, "packages", `${hash}.tgz`)), false, "and so is the archive");
    assert.deepEqual((await rows(hash)).map((row) => row.status), ["staged", "refused"]);
  });
});
