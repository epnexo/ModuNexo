import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn as spawnProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
let workDir: string;
beforeEach(() => {
  modulesDir = mkdtempSync(join(tmpdir(), "modunexo-cli-jobs-"));
  workDir = mkdtempSync(join(tmpdir(), "modunexo-cli-jobs-out-"));
  for (const id of ["alpha", "beta"]) {
    mkdirSync(join(modulesDir, id, "migrations"), { recursive: true });
    mkdirSync(join(modulesDir, id, "jobs"), { recursive: true });
    const manifest = {
      id,
      version: "1.0.0",
      name: id,
      platform: "^0.1.0",
      dependsOn: {},
      schema: id,
      migrationsDir: "migrations",
      nav: [],
      jobs: id === "alpha" ? [{ name: "write", entry: "./jobs/write.ts", maxAttempts: 2 }, { name: "boom", entry: "./jobs/boom.ts", maxAttempts: 1 }, { name: "hang", entry: "./jobs/hang.ts" }] : [],
    };
    writeFileSync(join(modulesDir, id, "manifest.ts"), `export default ${JSON.stringify(manifest)};\n`);
    writeFileSync(join(modulesDir, id, "package.json"), JSON.stringify({ name: `@fixture/${id}`, private: true }));
    writeFileSync(join(modulesDir, id, "migrations", "0001_init.sql"), "create table t (id int);");
  }
  // Plain Node only: a fixture folder in /tmp cannot import the SDK, so the handlers use the file system.
  writeFileSync(
    join(modulesDir, "alpha", "jobs", "write.ts"),
    `import { writeFileSync } from "node:fs";\nexport default async function (ctx: { payload: { file: string; text: string }; attempt: number }) {\n  writeFileSync(ctx.payload.file, ctx.payload.text + ":" + ctx.attempt);\n}\n`,
  );
  writeFileSync(join(modulesDir, "alpha", "jobs", "hang.ts"), `export default function () {\n  return new Promise(() => {});\n}\n`);
  writeFileSync(join(modulesDir, "alpha", "jobs", "boom.ts"), `export default async function () {\n  throw new Error("the fixture always fails");\n}\n`);
});
afterEach(() => {
  rmSync(modulesDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

type Cli = (args: string[]) => Promise<Outcome>;

async function inScratchDatabase(t: TestContext, work: (db: pg.Pool, cli: Cli, url: string) => Promise<void>): Promise<void> {
  const scratch = await createScratchDatabase();
  if (!scratch.url) return t.skip(scratch.skipReason);
  const url = scratch.url;
  const db = createPool(url);
  const cli: Cli = (args) => run([...args, "--modules-dir", modulesDir], { DATABASE_URL: url });
  try {
    assert.equal((await cli(["db:migrate"])).code, 0);
    assert.equal((await cli(["modules", "install", "alpha"])).code, 0);
    await work(db, cli, url);
  } finally {
    await db.end();
    await scratch.drop();
  }
}

const until = async (check: () => boolean | Promise<boolean>, ms = 20_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
};

describe("cli: jobs enqueue, list, cancel and retry", () => {
  it("enqueues a declared job and lists it without its payload", async (t) => {
    await inScratchDatabase(t, async (db, cli) => {
      const made = await cli(["jobs", "enqueue", "alpha", "write", "--payload", '{"file":"/x","text":"hello-secret"}', "--delay-seconds", "3600"]);
      assert.equal(made.code, 0, made.stderr);
      assert.equal(made.stdout.trim(), "queued job 1 (alpha write)");
      const row = (await db.query("select * from core.jobs")).rows[0];
      assert.deepEqual([row.status, row.enqueued_by, row.max_attempts, row.payload], ["queued", "cli", 2, { file: "/x", text: "hello-secret" }]);
      assert.ok(row.run_at.getTime() > Date.now() + 3_500_000);
      const list = await cli(["jobs", "list"]);
      assert.equal(list.code, 0, list.stderr);
      assert.match(list.stdout, /ID\s+MODULE\s+JOB\s+STATUS\s+ATTEMPTS\s+RUN AT\s+ERROR/);
      assert.match(list.stdout, /1\s+alpha\s+write\s+queued\s+0\/2/);
      assert.ok(!list.stdout.includes("hello-secret"), "the payload is not in the table");
      const json = JSON.parse((await cli(["jobs", "list", "alpha", "--json"])).stdout);
      assert.equal(json[0].payload.text, "hello-secret", "--json carries it");
      assert.equal((await cli(["jobs", "list", "beta"])).stdout.trim(), "no jobs");
      assert.equal((await cli(["jobs", "list", "--status", "dead"])).stdout.trim(), "no jobs");
    });
  });

  it("says when a dedupe key returned the job that was already there", async (t) => {
    await inScratchDatabase(t, async (_db, cli) => {
      assert.equal((await cli(["jobs", "enqueue", "alpha", "write", "--dedupe-key", "k1"])).stdout.trim(), "queued job 1 (alpha write)");
      const again = await cli(["jobs", "enqueue", "alpha", "write", "--dedupe-key", "k1"]);
      assert.equal(again.code, 0);
      assert.equal(again.stdout.trim(), "job 1 (alpha write) is already active for that dedupe key");
    });
  });

  it("refuses an unknown module, an undeclared job and a bad option with exit code 3", async (t) => {
    await inScratchDatabase(t, async (db, cli) => {
      const unknown = await cli(["jobs", "enqueue", "ghost", "write"]);
      assert.equal(unknown.code, 3);
      assert.match(unknown.stderr, /^refused: module "ghost" is not registered/);
      const undeclared = await cli(["jobs", "enqueue", "alpha", "nope"]);
      assert.equal(undeclared.code, 3);
      assert.match(undeclared.stderr, /does not declare the job "nope" \(declared: boom, write\)/);
      const none = await cli(["jobs", "enqueue", "beta", "write"]);
      assert.equal(none.code, 3);
      const key = await cli(["jobs", "enqueue", "alpha", "write", "--dedupe-key", "~schedule"]);
      assert.equal(key.code, 3);
      assert.equal((await db.query("select 1 from core.jobs")).rowCount, 0);
    });
  });

  it("answers a usage error, exit code 2, for missing arguments and bad options", async (t) => {
    await inScratchDatabase(t, async (_db, cli) => {
      for (const [args, expected] of [
        [["jobs"], /no jobs command/],
        [["jobs", "frob"], /unknown jobs command/],
        [["jobs", "enqueue", "alpha"], /takes a module id and a job name/],
        [["jobs", "enqueue", "alpha", "write", "extra"], /takes a module id and a job name/],
        [["jobs", "enqueue", "alpha", "write", "--payload", "{not json"], /--payload takes JSON/],
        [["jobs", "enqueue", "alpha", "write", "--delay-seconds=-1"], /--delay-seconds takes a whole number/],
        [["jobs", "enqueue", "alpha", "write", "--delay-seconds", "x"], /--delay-seconds/],
        [["jobs", "list", "--status", "weird"], /--status takes/],
        [["jobs", "list", "a", "b"], /at most one module id/],
        [["jobs", "list", "--payload", "{}"], /does not apply/],
        [["jobs", "cancel"], /needs a job id/],
        [["jobs", "cancel", "abc"], /whole number/],
        [["jobs", "retry", "1", "2"], /exactly one/],
      ] as Array<[string[], RegExp]>) {
        const result = await cli(args);
        assert.equal(result.code, 2, `${args.join(" ")}: ${result.stderr}`);
        assert.match(result.stderr, expected, args.join(" "));
      }
    });
  });

  it("cancels a queued job, retries a dead one, and refuses the other states with exit code 3", async (t) => {
    await inScratchDatabase(t, async (db, cli) => {
      await cli(["jobs", "enqueue", "alpha", "write", "--delay-seconds", "600"]);
      const cancelled = await cli(["jobs", "cancel", "1"]);
      assert.equal(cancelled.code, 0, cancelled.stderr);
      assert.equal(cancelled.stdout.trim(), "cancelled job 1 (alpha write)");
      const again = await cli(["jobs", "cancel", "1"]);
      assert.equal(again.code, 3);
      assert.match(again.stderr, /^refused: job 1 is cancelled: only a queued job can be cancelled/);
      assert.equal((await cli(["jobs", "cancel", "999"])).code, 3);

      await cli(["jobs", "enqueue", "alpha", "boom"]);
      await db.query("update core.jobs set status = 'dead', attempts = 1, finished_at = now(), last_error = 'the fixture always fails' where id = 2");
      assert.match((await cli(["jobs", "list", "--status", "dead"])).stdout, /2\s+alpha\s+boom\s+dead\s+1\/1.*the fixture always fails/);
      const retried = await cli(["jobs", "retry", "2"]);
      assert.equal(retried.code, 0, retried.stderr);
      assert.equal(retried.stdout.trim(), "queued job 2 again (alpha boom)");
      assert.equal((await db.query("select status, attempts from core.jobs where id = 2")).rows[0].status, "queued");
      const refused = await cli(["jobs", "retry", "2"]);
      assert.equal(refused.code, 3);
      assert.match(refused.stderr, /is queued: only a dead job can be retried/);
    });
  });
});

describe("cli: worker", () => {
  const startWorker = (url: string, extra: string[] = []): { child: ChildProcess; output: () => string } => {
    const child = spawnProcess(process.execPath, ["--import", "tsx", script, "worker", "--modules-dir", modulesDir, "--poll-ms", "100", ...extra], {
      env: { PATH: process.env.PATH, DATABASE_URL: url },
    });
    let text = "";
    child.stdout?.on("data", (chunk) => (text += chunk));
    child.stderr?.on("data", (chunk) => (text += chunk));
    return { child, output: () => text };
  };
  const exited = (child: ChildProcess) => new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));

  it("runs an enqueued job from the module's folder, retries nothing it should not, and stops cleanly on SIGTERM", async (t) => {
    await inScratchDatabase(t, async (db, cli, url) => {
      const file = join(workDir, "out.txt");
      const { child, output } = startWorker(url);
      try {
        assert.equal((await cli(["jobs", "enqueue", "alpha", "write", "--payload", JSON.stringify({ file, text: "done" })])).code, 0);
        assert.ok(await until(() => existsSync(file)), `the handler never ran:\n${output()}`);
        assert.equal(readFileSync(file, "utf8"), "done:1");
        assert.ok(await until(async () => (await db.query("select status from core.jobs where id = 1")).rows[0].status === "succeeded"));
        child.kill("SIGTERM");
        assert.equal(await exited(child), 0, output());
      } finally {
        child.kill("SIGKILL");
      }
      assert.match(output(), /worker\.started/);
      assert.match(output(), /worker\.stopped/);
    });
  });

  it("ends a job that always fails dead, with the handler's message, and keeps running", async (t) => {
    await inScratchDatabase(t, async (db, cli, url) => {
      const { child, output } = startWorker(url);
      try {
        await cli(["jobs", "enqueue", "alpha", "boom"]);
        assert.ok(await until(async () => (await db.query("select status from core.jobs where id = 1")).rows[0].status === "dead"), output());
        assert.equal((await db.query("select last_error from core.jobs where id = 1")).rows[0].last_error, "the fixture always fails");
        const file = join(workDir, "after.txt");
        await cli(["jobs", "enqueue", "alpha", "write", "--payload", JSON.stringify({ file, text: "x" })]);
        assert.ok(await until(() => existsSync(file)), "the worker went on after a dead job");
        child.kill("SIGINT");
        assert.equal(await exited(child), 0);
      } finally {
        child.kill("SIGKILL");
      }
    });
  });

  it("exits within the grace period even when a job never finishes, and leaves that job running for its lease", async (t) => {
    await inScratchDatabase(t, async (db, cli, url) => {
      const { child, output } = startWorker(url, ["--grace-seconds", "1"]);
      try {
        await cli(["jobs", "enqueue", "alpha", "hang"]);
        assert.ok(await until(async () => (await db.query("select status from core.jobs where id = 1")).rows[0].status === "running"), output());
        const started = Date.now();
        child.kill("SIGTERM");
        assert.equal(await exited(child), 0, output());
        assert.ok(Date.now() - started < 8000, `took ${Date.now() - started} ms, and the job's own 60 s timeout is still pending`);
        assert.equal((await db.query("select status from core.jobs where id = 1")).rows[0].status, "running");
        assert.match(output(), /abandoned/);
      } finally {
        child.kill("SIGKILL");
      }
    });
  });

  it("refuses to start before the jobs table exists, and rejects bad options", async (t) => {
    const scratch = await createScratchDatabase();
    if (!scratch.url) return t.skip(scratch.skipReason);
    try {
      const bare = await run(["worker", "--modules-dir", modulesDir], { DATABASE_URL: scratch.url });
      assert.notEqual(bare.code, 0);
      assert.match(bare.stderr, /db:migrate/);
      for (const [args, expected] of [
        [["worker", "--concurrency", "0"], /--concurrency takes a whole number from 1 to 32/],
        [["worker", "--concurrency", "x"], /--concurrency/],
        [["worker", "--poll-ms", "10"], /--poll-ms takes a whole number from 100 to 60000/],
        [["worker", "--grace-seconds", "0"], /--grace-seconds takes a whole number from 1 to 300/],
        [["worker", "--grace-seconds", "301"], /--grace-seconds takes a whole number from 1 to 300/],
        [["worker", "extra"], /takes no arguments/],
        [["worker", "--json"], /does not apply/],
      ] as Array<[string[], RegExp]>) {
        const result = await run(args, { DATABASE_URL: scratch.url });
        assert.equal(result.code, 2, args.join(" "));
        assert.match(result.stderr, expected);
      }
    } finally {
      await scratch.drop();
    }
  });
});
