import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type TestContext, afterEach, beforeEach, describe, it } from "node:test";
import type pg from "pg";
import { createPool } from "../src/pool.ts";
import { createScratchDatabase } from "../src/testing.ts";
import { hashToken } from "../src/tokens/format.ts";

const script = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
}

const spawn = (args: string[], env: Record<string, string>): Promise<Outcome> =>
  new Promise((resolve) => {
    const child = execFile(process.execPath, ["--import", "tsx", script, ...args], { env: { PATH: process.env.PATH, ...env } }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : ((error as { code?: number }).code ?? 1), stdout, stderr });
    });
    child.stdin?.end("");
  });

let modulesDir: string;
beforeEach(() => {
  modulesDir = mkdtempSync(join(tmpdir(), "modunexo-cli-tokens-"));
  for (const id of ["alpha", "beta"]) {
    mkdirSync(join(modulesDir, id, "migrations"), { recursive: true });
    const manifest = {
      id,
      version: "1.0.0",
      name: id,
      platform: "^0.1.0",
      dependsOn: {},
      schema: id,
      migrationsDir: "migrations",
      nav: [],
      scopes: id === "alpha" ? [{ key: "messages.read", label: "Read" }, { key: "messages.send", label: "Send" }] : [],
    };
    writeFileSync(join(modulesDir, id, "manifest.ts"), `export default ${JSON.stringify(manifest)};\n`);
    writeFileSync(join(modulesDir, id, "package.json"), JSON.stringify({ name: `@fixture/${id}`, private: true }));
    writeFileSync(join(modulesDir, id, "migrations", "0001_init.sql"), "create table t (id int);");
  }
});
afterEach(() => rmSync(modulesDir, { recursive: true, force: true }));

type Cli = (args: string[]) => Promise<Outcome>;

async function inScratchDatabase(t: TestContext, work: (db: pg.Pool, cli: Cli) => Promise<void>): Promise<void> {
  const scratch = await createScratchDatabase();
  if (!scratch.url) return t.skip(scratch.skipReason);
  const url = scratch.url;
  const db = createPool(url);
  const cli: Cli = (args) => spawn([...args, "--modules-dir", modulesDir], { DATABASE_URL: url });
  try {
    assert.equal((await cli(["db:migrate"])).code, 0);
    await work(db, cli);
  } finally {
    await db.end();
    await scratch.drop();
  }
}

const TOKEN = /mdnx_[0-9a-f]{8}_[A-Za-z0-9_-]{43}/;

describe("cli: tokens create", () => {
  it("prints the token once on stdout, a note on stderr, and stores only the hash", async (t) => {
    await inScratchDatabase(t, async (db, cli) => {
      const made = await cli(["tokens", "create", "alpha", "--name", "inbox sync", "--scope", "messages.read", "--scope", "messages.send"]);
      assert.equal(made.code, 0, made.stderr);
      const token = made.stdout.trim();
      assert.match(token, new RegExp(`^${TOKEN.source}$`), "stdout is the token and nothing else");
      assert.match(made.stderr, /shown once/i);
      const row = (await db.query("select * from core.service_tokens")).rows[0];
      assert.equal(row.module_id, "alpha");
      assert.equal(row.name, "inbox sync");
      assert.deepEqual(row.scopes, ["messages.read", "messages.send"]);
      assert.equal(row.token_hash, hashToken(token));
      assert.equal(row.created_by, "cli");
      assert.equal(row.expires_at, null);
    });
  });

  it("sets an expiry with --expires-in-days", async (t) => {
    await inScratchDatabase(t, async (db, cli) => {
      const made = await cli(["tokens", "create", "alpha", "--name", "short", "--scope", "messages.read", "--expires-in-days", "30"]);
      assert.equal(made.code, 0, made.stderr);
      const row = (await db.query("select extract(epoch from (expires_at - created_at)) / 86400 as days from core.service_tokens")).rows[0];
      assert.ok(Math.abs(Number(row.days) - 30) < 0.01, String(row.days));
    });
  });

  it("refuses an unknown module, an undeclared scope and a module with no scopes with exit code 3", async (t) => {
    await inScratchDatabase(t, async (db, cli) => {
      const unknown = await cli(["tokens", "create", "ghost", "--name", "x", "--scope", "messages.read"]);
      assert.equal(unknown.code, 3);
      assert.match(unknown.stderr, /^refused: module "ghost" is not registered/);
      const undeclared = await cli(["tokens", "create", "alpha", "--name", "x", "--scope", "messages.delete"]);
      assert.equal(undeclared.code, 3);
      assert.match(undeclared.stderr, /does not declare the scope "messages.delete"/);
      const none = await cli(["tokens", "create", "beta", "--name", "x", "--scope", "messages.read"]);
      assert.equal(none.code, 3);
      assert.match(none.stderr, /it declares none/);
      assert.equal((await db.query("select 1 from core.service_tokens")).rowCount, 0);
    });
  });

  it("answers a usage error, exit code 2, when something is missing or does not apply", async (t) => {
    await inScratchDatabase(t, async (_db, cli) => {
      for (const [args, expected] of [
        [["tokens", "create"], /needs a module id/],
        [["tokens", "create", "alpha", "--scope", "messages.read"], /needs --name/],
        [["tokens", "create", "alpha", "--name", "x"], /needs at least one --scope/],
        [["tokens", "create", "alpha", "--name", "x", "--scope", "messages.read", "--expires-in-days", "0"], /--expires-in-days takes a whole number from 1 to 3650/],
        [["tokens", "create", "alpha", "--name", "x", "--scope", "messages.read", "--expires-in-days", "abc"], /--expires-in-days/],
        [["tokens", "create", "alpha", "beta", "--name", "x", "--scope", "messages.read"], /takes exactly one module id/],
        [["tokens", "list", "--scope", "x"], /does not apply/],
        [["tokens", "revoke"], /needs a token id/],
        [["tokens", "revoke", "abc"], /whole number/],
        [["tokens", "revoke", "1", "2"], /exactly one/],
        [["tokens", "frob"], /unknown tokens command/],
        [["tokens"], /no tokens command/],
      ] as Array<[string[], RegExp]>) {
        const result = await cli(args);
        assert.equal(result.code, 2, `${args.join(" ")}: ${result.stderr}`);
        assert.match(result.stderr, expected, args.join(" "));
      }
    });
  });
});

describe("cli: tokens list and revoke", () => {
  it("lists tokens with their state and never prints a token or a hash", async (t) => {
    await inScratchDatabase(t, async (db, cli) => {
      const made = (await cli(["tokens", "create", "alpha", "--name", "one", "--scope", "messages.read"])).stdout.trim();
      await cli(["tokens", "create", "alpha", "--name", "two", "--scope", "messages.send", "--expires-in-days", "5"]);
      const list = await cli(["tokens", "list"]);
      assert.equal(list.code, 0, list.stderr);
      assert.match(list.stdout, /ID\s+MODULE\s+NAME\s+PREFIX\s+SCOPES\s+STATE/);
      assert.match(list.stdout, /1\s+alpha\s+one\s+[0-9a-f]{8}\s+messages\.read\s+active/);
      assert.match(list.stdout, /2\s+alpha\s+two\s+[0-9a-f]{8}\s+messages\.send\s+active/);
      assert.ok(!list.stdout.includes(made) && !list.stdout.includes(hashToken(made)));
      const json = JSON.parse((await cli(["tokens", "list", "alpha", "--json"])).stdout);
      assert.equal(json.length, 2);
      assert.ok(!JSON.stringify(json).includes(made) && !JSON.stringify(json).includes(hashToken(made)));
      assert.equal((await cli(["tokens", "list", "beta"])).stdout.trim(), "no tokens");
      await db.query("update core.service_tokens set expires_at = now() - interval '1 day' where id = 2");
      assert.match((await cli(["tokens", "list"])).stdout, /2\s+alpha\s+two.*expired/);
    });
  });

  it("revokes a token, shows it revoked, and refuses an unknown id with exit code 3", async (t) => {
    await inScratchDatabase(t, async (db, cli) => {
      await cli(["tokens", "create", "alpha", "--name", "one", "--scope", "messages.read"]);
      const revoked = await cli(["tokens", "revoke", "1"]);
      assert.equal(revoked.code, 0, revoked.stderr);
      assert.equal(revoked.stdout.trim(), "revoked token 1 (alpha, one)");
      assert.match((await cli(["tokens", "list"])).stdout, /1\s+alpha\s+one.*revoked/);
      const events = (await db.query("select action, actor from core.service_token_events order by id")).rows;
      assert.deepEqual(events, [{ action: "created", actor: "cli" }, { action: "revoked", actor: "cli" }]);
      const again = await cli(["tokens", "revoke", "1"]);
      assert.equal(again.code, 0);
      assert.equal((await db.query("select 1 from core.service_token_events")).rowCount, 2, "revoking twice records once");
      const missing = await cli(["tokens", "revoke", "999"]);
      assert.equal(missing.code, 3);
      assert.match(missing.stderr, /^refused: there is no token 999/);
    });
  });
});
