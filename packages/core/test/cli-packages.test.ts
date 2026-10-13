import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type TestContext, afterEach, beforeEach, describe, it } from "node:test";
import { SDK_VERSION } from "@epnexo/sdk";
import type pg from "pg";
import { createPool } from "../src/pool.ts";
import { createScratchDatabase } from "../src/testing.ts";

const script = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));
const tsx = import.meta.resolve("tsx");

interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
}

const spawn = (args: string[], env: Record<string, string>, cwd?: string): Promise<Outcome> =>
  new Promise((resolve) => {
    execFile(process.execPath, ["--import", tsx, script, ...args], { env: { PATH: process.env.PATH, ...env }, ...(cwd === undefined ? {} : { cwd }) }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : ((error as { code?: number }).code ?? 1), stdout, stderr });
    });
  });

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "epnexo-cli-packages-"));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

const put = (root: string, path: string, content: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
};

/** A module folder as an author would have it: a manifest.ts that is code, sources and migrations. */
function moduleFolder(name = "reports-src", options: { manifest?: Record<string, unknown>; dependencies?: Record<string, string> } = {}) {
  const root = join(work, name);
  const manifest = {
    id: "reports",
    version: "1.0.0",
    name: "Reports",
    platform: `^${SDK_VERSION}`,
    dependsOn: {},
    schema: "reports",
    migrationsDir: "migrations",
    nav: [{ label: "Reports", href: "/reports" }],
    pages: [{ path: "/reports", entry: "./web/page.tsx", kind: "page" }],
    ...options.manifest,
  };
  put(root, "manifest.ts", `const value = ${JSON.stringify(manifest)};\nexport default value;\n`);
  put(root, "package.json", JSON.stringify({ name: "@acme/reports", version: manifest.version, dependencies: options.dependencies ?? {} }));
  put(root, "migrations/0001_init.sql", "create table items (id int);\n");
  put(root, "web/page.tsx", "export default function Page() { return null; }\n");
  return root;
}

const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

describe("cli: modules pack", () => {
  it("builds an archive with the manifest written as data, and prints its size and SHA-256", async () => {
    const folder = moduleFolder();
    const out = join(work, "reports-1.0.0.tgz");
    const result = await spawn(["modules", "pack", folder, "--out", out], {});
    assert.equal(result.code, 0, result.stderr);
    assert.ok(existsSync(out));
    assert.match(result.stdout, new RegExp(`packed ${out.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(\\d+ bytes\\)`));
    assert.match(result.stdout, new RegExp(`sha256 ${sha(out)}`));
    assert.equal(existsSync(join(folder, "manifest.json")), false, "the author's folder is not modified");
  });

  it("is reproducible: the same folder gives the same bytes", async () => {
    const folder = moduleFolder();
    await spawn(["modules", "pack", folder, "--out", join(work, "a.tgz")], {});
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await spawn(["modules", "pack", folder, "--out", join(work, "b.tgz")], {});
    assert.equal(sha(join(work, "a.tgz")), sha(join(work, "b.tgz")));
  });

  it("names the archive after the module when no --out is given, in the current folder", async () => {
    const folder = moduleFolder();
    const cwd = mkdtempSync(join(work, "cwd-"));
    const result = await spawn(["modules", "pack", folder], {}, cwd);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(existsSync(join(cwd, "reports-1.0.0.tgz")));
  });

  it("leaves out node_modules, .git, build output, environment files and archives, which must not travel", async () => {
    const folder = moduleFolder();
    for (const path of ["node_modules/x/index.js", ".git/config", ".next/cache.bin", ".env", ".env.production", "old.tgz", ".DS_Store", "web/.env.local", ".envrc", ".env-prod", ".env_local"]) put(folder, path, "secret");
    const out = join(work, "out.tgz");
    assert.equal((await spawn(["modules", "pack", folder, "--out", out], {})).code, 0);
    const tar = await import("tar");
    const names: string[] = [];
    await tar.list({ file: out, onReadEntry: (entry) => void names.push(String(entry.path)) });
    for (const banned of ["node_modules", ".git", ".next", ".env", ".tgz", ".DS_Store"]) assert.ok(!names.some((n) => n.includes(banned)), `${banned} must not be packed: ${names.join(", ")}`);
    assert.ok(names.includes("package/manifest.json"));
    assert.ok(names.includes("package/manifest.ts"));
    assert.ok(names.includes("package/migrations/0001_init.sql"));
  });

  it("refuses a folder with a symbolic link, naming it, and writes no archive", async () => {
    const folder = moduleFolder();
    symlinkSync("/etc/passwd", join(folder, "web/link"));
    const out = join(work, "out.tgz");
    const result = await spawn(["modules", "pack", folder, "--out", out], {});
    assert.equal(result.code, 3);
    assert.match(result.stderr, /web\/link.*symbolic link/s);
    assert.equal(existsSync(out), false);
  });

  it("applies the archive rules intake applies, so a folder is not packed that would be refused on arrival", async () => {
    const folder = moduleFolder("parity-src");
    put(folder, "web/Widget.tsx", "export {};\n");
    put(folder, "web/widget.tsx", "export {};\n");
    const out = join(work, "parity.tgz");
    const result = await spawn(["modules", "pack", folder, "--out", out], {});
    assert.equal(result.code, 3);
    assert.match(result.stderr, /duplicate/);
    assert.equal(existsSync(out), false);

    const long = moduleFolder("long-src");
    put(long, `web/${"d".repeat(120)}/${"e".repeat(120)}/file.ts`, "export {};\n");
    const refused = await spawn(["modules", "pack", long, "--out", join(work, "long.tgz")], {});
    assert.equal(refused.code, 3);
    assert.match(refused.stderr, /255|long/i);
  });

  it("refuses a package that would not pass intake, with the problems, and writes no archive", async () => {
    const folder = moduleFolder("bad-src", { dependencies: { "left-pad": "^1.0.0" } });
    rmSync(join(folder, "web/page.tsx"));
    const out = join(work, "out.tgz");
    const result = await spawn(["modules", "pack", folder, "--out", out], {});
    assert.equal(result.code, 3);
    assert.match(result.stderr, /left-pad/);
    assert.match(result.stderr, /page\.tsx/);
    assert.equal(existsSync(out), false);
  });

  it("refuses a folder with no manifest.ts, a manifest that is not valid and one that cannot be loaded", async () => {
    const empty = join(work, "empty");
    mkdirSync(empty);
    assert.equal((await spawn(["modules", "pack", empty], {})).code, 3);
    const invalid = moduleFolder("invalid-src", { manifest: { id: "Not Kebab" } });
    const bad = await spawn(["modules", "pack", invalid, "--out", join(work, "i.tgz")], {});
    assert.equal(bad.code, 3);
    assert.match(bad.stderr, /manifest/);
    const broken = moduleFolder("broken-src");
    put(broken, "manifest.ts", "throw new Error('boom');\n");
    const crashed = await spawn(["modules", "pack", broken, "--out", join(work, "c.tgz")], {});
    assert.equal(crashed.code, 3);
    assert.match(crashed.stderr, /boom/);
  });

  it("is a usage error without a folder, and refuses a folder that does not exist", async () => {
    assert.equal((await spawn(["modules", "pack"], {})).code, 2);
    assert.equal((await spawn(["modules", "pack", join(work, "nope")], {})).code, 3);
  });
});

async function inScratchDatabase(t: TestContext, work2: (db: pg.Pool, cli: (...args: string[]) => Promise<Outcome>, data: string) => Promise<void>) {
  const scratch = await createScratchDatabase();
  if (!scratch.url) return t.skip(scratch.skipReason);
  const url = scratch.url;
  const db = createPool(url);
  const data = join(work, "var");
  const cli = (...args: string[]) => spawn([...args, "--data-dir", data], { DATABASE_URL: url });
  try {
    assert.equal((await spawn(["db:migrate"], { DATABASE_URL: url })).code, 0);
    await work2(db, cli, data);
  } finally {
    await db.end();
    await scratch.drop();
  }
}

describe("cli: modules add", () => {
  it("stages a packed module and prints what it would do, without installing it", async (t) => {
    await inScratchDatabase(t, async (db, cli, data) => {
      const out = join(work, "reports.tgz");
      assert.equal((await spawn(["modules", "pack", moduleFolder(), "--out", out], {})).code, 0);
      const result = await cli("modules", "add", out);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /staged reports 1\.0\.0 \(Reports\)/);
      assert.match(result.stdout, new RegExp(`sha256\\s+${sha(out)}`));
      assert.match(result.stdout, /migrations\s+0001_init\.sql/);
      assert.match(result.stdout, /hooks\s+none/);
      assert.match(result.stdout, /Nothing was installed/);
      assert.ok(existsSync(join(data, "staging", sha(out), "manifest.json")));
      const rows = (await db.query("select module_id, version, status, actor from core.module_packages")).rows;
      assert.deepEqual(rows, [{ module_id: "reports", version: "1.0.0", status: "staged", actor: "cli" }]);
      assert.equal((await db.query("select 1 from core.modules")).rowCount, 0, "nothing was installed");
    });
  });

  it("prints the review as JSON on request", async (t) => {
    await inScratchDatabase(t, async (_db, cli) => {
      const out = join(work, "reports.tgz");
      await spawn(["modules", "pack", moduleFolder(), "--out", out], {});
      const result = await cli("modules", "add", out, "--json");
      assert.equal(result.code, 0, result.stderr);
      const data = JSON.parse(result.stdout);
      assert.equal(data.status, "staged");
      assert.equal(data.sha256, sha(out));
      assert.equal(data.review.id, "reports");
      assert.deepEqual(data.review.migrations, ["0001_init.sql"]);
    });
  });

  it("refuses an archive whose SHA-256 is not the one given, with exit code 3 and nothing kept", async (t) => {
    await inScratchDatabase(t, async (_db, cli, data) => {
      const out = join(work, "reports.tgz");
      await spawn(["modules", "pack", moduleFolder(), "--out", out], {});
      const result = await cli("modules", "add", out, "--sha256", "f".repeat(64));
      assert.equal(result.code, 3);
      assert.match(result.stderr, /^refused: /);
      assert.match(result.stderr, /not the expected f{64}/);
      assert.equal(existsSync(join(data, "staging")) ? readdirSync(join(data, "staging")).length : 0, 0);
      assert.equal((await cli("modules", "add", out, "--sha256", sha(out))).code, 0);
    });
  });

  it("lists every problem of a package that is refused", async (t) => {
    await inScratchDatabase(t, async (_db, cli) => {
      const archive = join(work, "bad.tgz");
      const { tgz } = await import("./helpers/tarball.ts");
      writeFileSync(archive, tgz([{ name: "package/../evil", data: "x" }, { name: "package/a", type: "2", linkname: "x" }]));
      const result = await cli("modules", "add", archive);
      assert.equal(result.code, 3);
      assert.match(result.stderr, /"\.\."/);
      assert.match(result.stderr, /symbolic link/);
    });
  });

  it("is a usage error without an archive, with a bad --sha256 value or an option that does not apply", async (t) => {
    await inScratchDatabase(t, async (_db, cli) => {
      assert.equal((await cli("modules", "add")).code, 2);
      assert.equal((await cli("modules", "add", join(work, "x.tgz"), "--sha256", "nope")).code, 2);
      assert.equal((await cli("modules", "add", join(work, "x.tgz"), "--keep")).code, 2);
      assert.equal((await cli("modules", "install", "reports", "--sha256", "a".repeat(64))).code, 2);
    });
  });

  it("fails with exit code 1 for an archive that does not exist", async (t) => {
    await inScratchDatabase(t, async (_db, cli) => {
      assert.equal((await cli("modules", "add", join(work, "missing.tgz"))).code, 1);
    });
  });

  it("is listed in --help with pack", async () => {
    const result = await spawn(["--help"], {});
    assert.match(result.stdout, /modules pack <folder>/);
    assert.match(result.stdout, /modules add <archive>/);
    assert.match(result.stdout, /--sha256/);
    assert.match(result.stdout, /--data-dir/);
  });
});

describe("cli: nothing from a package runs", () => {
  it("adds a package whose every file would leave a mark if it were run, and no mark appears", async (t) => {
    await inScratchDatabase(t, async (db, cli, data) => {
      const { tgz } = await import("./helpers/tarball.ts");
      const mark = join(work, "ran-marker");
      const code = `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(mark)}, "ran");\n`;
      const manifest = {
        id: "reports",
        version: "1.0.0",
        name: "Reports",
        platform: `^${SDK_VERSION}`,
        dependsOn: {},
        schema: "reports",
        migrationsDir: "migrations",
        hooks: "./hooks.ts",
        nav: [],
        pages: [{ path: "/reports", entry: "./web/page.tsx", kind: "page" }],
      };
      const scripts = Object.fromEntries(["preinstall", "install", "postinstall", "prepare", "prepack"].map((name) => [name, `node -e "require('fs').writeFileSync(${JSON.stringify(mark)},'ran')"`]));
      const archive = join(work, "hostile.tgz");
      writeFileSync(
        archive,
        tgz([
          { name: "package/package.json", data: JSON.stringify({ name: "@acme/reports", version: "1.0.0", scripts }) },
          { name: "package/manifest.json", data: JSON.stringify(manifest) },
          { name: "package/manifest.ts", data: code },
          { name: "package/hooks.ts", data: code },
          { name: "package/web/page.tsx", data: `${code}export default function Page() { return null; }\n` },
          { name: "package/migrations/0001_init.sql", data: "select 1;\n" },
        ]),
      );
      const result = await cli("modules", "add", archive);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /hooks\s+yes/);
      assert.match(result.stdout, /scripts\s+install, postinstall, preinstall, prepack, prepare \(never run\)/);
      assert.equal(existsSync(mark), false, "something from the package ran");
      assert.equal((await db.query("select 1 from core.modules")).rowCount, 0);
      assert.equal((await db.query("select 1 from information_schema.schemata where schema_name = 'reports'")).rowCount, 0);
    });
  });
});
