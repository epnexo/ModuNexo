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

const script = fileURLToPath(new URL("../src/cli/index.ts", import.meta.url));

interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
}

const run = (args: string[], env: Record<string, string>): Promise<Outcome> =>
  new Promise((resolve) => {
    const child = execFile(process.execPath, ["--import", "tsx", script, ...args], { env: { PATH: process.env.PATH, ...env } }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : ((error as { code?: number }).code ?? 1), stdout, stderr });
    });
    child.stdin?.end("");
  });

let modulesDir: string;
beforeEach(() => {
  modulesDir = mkdtempSync(join(tmpdir(), "modunexo-cli-events-"));
  for (const id of ["alpha", "beta"]) {
    mkdirSync(join(modulesDir, id, "migrations"), { recursive: true });
    mkdirSync(join(modulesDir, id, "jobs"), { recursive: true });
    const manifest =
      id === "alpha"
        ? {
            id,
            version: "1.0.0",
            name: id,
            platform: "^0.1.0",
            dependsOn: {},
            schema: id,
            migrationsDir: "migrations",
            nav: [],
            jobs: [{ name: "on_created", entry: "./jobs/on_created.ts" }],
            events: [{ name: "created" }, { name: "closed" }],
            subscriptions: [{ event: "alpha.created", job: "on_created" }],
          }
        : { id, version: "1.0.0", name: id, platform: "^0.1.0", dependsOn: {}, schema: id, migrationsDir: "migrations", nav: [] };
    writeFileSync(join(modulesDir, id, "manifest.ts"), `export default ${JSON.stringify(manifest)};\n`);
    writeFileSync(join(modulesDir, id, "package.json"), JSON.stringify({ name: `@fixture/${id}`, private: true }));
    writeFileSync(join(modulesDir, id, "migrations", "0001_init.sql"), "create table t (id int);");
  }
  writeFileSync(join(modulesDir, "alpha", "jobs", "on_created.ts"), "export default async function () {}\n");
});
afterEach(() => {
  rmSync(modulesDir, { recursive: true, force: true });
});

type Cli = (args: string[]) => Promise<Outcome>;

async function inScratchDatabase(t: TestContext, work: (db: pg.Pool, cli: Cli) => Promise<void>): Promise<void> {
  const scratch = await createScratchDatabase();
  if (!scratch.url) return t.skip(scratch.skipReason);
  const url = scratch.url;
  const db = createPool(url);
  const cli: Cli = (args) => run([...args, "--modules-dir", modulesDir], { DATABASE_URL: url });
  try {
    assert.equal((await cli(["db:migrate"])).code, 0);
    assert.equal((await cli(["modules", "install", "alpha"])).code, 0);
    await work(db, cli);
  } finally {
    await db.end();
    await scratch.drop();
  }
}

describe("cli: events publish and list", () => {
  it("publishes a declared event, queues the subscribed job, and lists it without its payload", async (t) => {
    await inScratchDatabase(t, async (db, cli) => {
      const made = await cli(["events", "publish", "alpha", "created", "--payload", '{"ticket":"hello-secret"}']);
      assert.equal(made.code, 0, made.stderr);
      assert.equal(made.stdout.trim(), "published event 1 (alpha.created)");
      const event = (await db.query("select module_id, type, payload from core.events")).rows[0];
      assert.deepEqual([event.module_id, event.type, event.payload], ["alpha", "alpha.created", { ticket: "hello-secret" }]);
      const job = (await db.query("select module_id, name, enqueued_by from core.jobs")).rows[0];
      assert.deepEqual([job.module_id, job.name, job.enqueued_by], ["alpha", "on_created", "event:alpha"]);

      await cli(["events", "publish", "alpha", "closed"]);
      const list = await cli(["events", "list"]);
      assert.equal(list.code, 0, list.stderr);
      assert.match(list.stdout, /ID\s+MODULE\s+TYPE\s+CREATED/);
      assert.match(list.stdout, /2\s+alpha\s+alpha\.closed/);
      assert.match(list.stdout, /1\s+alpha\s+alpha\.created/);
      assert.ok(!list.stdout.includes("hello-secret"), "the payload is not in the table");
      const json = JSON.parse((await cli(["events", "list", "alpha", "--type", "alpha.created", "--json"])).stdout);
      assert.equal(json.length, 1);
      assert.equal(json[0].payload.ticket, "hello-secret", "--json carries it");
      assert.equal(JSON.parse((await cli(["events", "list", "--limit", "1", "--json"])).stdout).length, 1);
      assert.equal((await cli(["events", "list", "beta"])).stdout.trim(), "no events");
    });
  });

  it("refuses an unknown module and an undeclared event with exit code 3, and stores nothing", async (t) => {
    await inScratchDatabase(t, async (db, cli) => {
      const unknown = await cli(["events", "publish", "ghost", "created"]);
      assert.equal(unknown.code, 3);
      assert.match(unknown.stderr, /^refused: module "ghost" is not registered/);
      const undeclared = await cli(["events", "publish", "alpha", "nope"]);
      assert.equal(undeclared.code, 3);
      assert.match(undeclared.stderr, /does not declare the event "nope" \(declared: closed, created\)/);
      assert.equal((await db.query("select 1 from core.events")).rowCount, 0);
    });
  });

  it("answers a usage error, exit code 2, for missing arguments and bad options", async (t) => {
    await inScratchDatabase(t, async (db, cli) => {
      for (const [args, expected] of [
        [["events"], /no events command/],
        [["events", "wipe"], /unknown events command "wipe"/],
        [["events", "publish", "alpha"], /events publish takes a module id and an event name/],
        [["events", "publish", "alpha", "created", "extra"], /events publish takes a module id and an event name/],
        [["events", "publish", "alpha", "created", "--payload", "{nope"], /--payload takes JSON/],
        [["events", "publish", "alpha", "created", "--limit", "5"], /option --limit does not apply to events publish/],
        [["events", "list", "a", "b"], /events list takes at most one module id/],
        [["events", "list", "--limit", "0"], /--limit takes a whole number from 1 to 500/],
        [["events", "list", "--limit", "501"], /--limit takes a whole number from 1 to 500/],
        [["events", "list", "--payload", "{}"], /option --payload does not apply to events list/],
      ] as Array<[string[], RegExp]>) {
        const outcome = await cli(args);
        assert.equal(outcome.code, 2, args.join(" "));
        assert.match(outcome.stderr, expected, args.join(" "));
      }
      assert.equal((await db.query("select 1 from core.events")).rowCount, 0);
    });
  });
});
