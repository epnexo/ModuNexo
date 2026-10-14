import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type pg from "pg";
import { LaunchBusyError, launchApply } from "../src/install/launch.ts";
import { finishOperation, startOperation } from "../src/operations/index.ts";
import { Registry } from "../src/registry.ts";
import { migrate } from "../src/runner.ts";
import { openTestPool } from "../src/testing.ts";

let pool: pg.Pool | undefined;
let skipReason: string | undefined;
let work: string;
const ACTOR = "launch-test";
const SHA = "ab".repeat(32);

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
    await pool.query("delete from core.module_operations where actor = $1", [ACTOR]);
    await pool.end();
  }
});
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "epnexo-launch-"));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

const test = (name: string, run: () => Promise<void>) =>
  it(name, async (t) => {
    if (!pool) return t.skip(skipReason);
    await pool.query("delete from core.module_operations where actor = $1", [ACTOR]);
    await run();
  });

/** A stand-in for the CLI: records its arguments and a marker, then exits. */
const recorder = () => {
  const script = join(work, "recorder.mjs");
  writeFileSync(script, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(join(work, "args.json"))}, JSON.stringify(process.argv.slice(2)));\nconsole.log("recorded");\n`);
  return script;
};
const until = async (condition: () => boolean) => {
  for (let i = 0; i < 100 && !condition(); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(condition(), "condition was not met in time");
};

describe("launchApply", () => {
  test("starts `modules apply` detached with the SHA-256 and the actor, and logs its output", async () => {
    const launched = await launchApply({ pool: pool!, sha256: SHA, actor: ACTOR, dataDir: join(work, "var"), entry: [recorder()] });
    assert.ok(launched.pid > 1);
    await until(() => existsSync(join(work, "args.json")));
    assert.deepEqual(JSON.parse(readFileSync(join(work, "args.json"), "utf8")), ["modules", "apply", SHA, "--actor", ACTOR, "--data-dir", join(work, "var")]);
    await until(() => existsSync(launched.logFile) && readFileSync(launched.logFile, "utf8").includes("recorded"));
    assert.ok(launched.logFile.startsWith(join(work, "var", "logs")));
  });

  test("refuses while another run is alive, and starts nothing", async () => {
    const running = await startOperation(pool!, { moduleId: "x", version: "1.0.0", sha256: "c".repeat(64), kind: "install", actor: ACTOR });
    await assert.rejects(launchApply({ pool: pool!, sha256: SHA, actor: ACTOR, dataDir: join(work, "var"), entry: [recorder()] }), LaunchBusyError);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(existsSync(join(work, "args.json")), false);
    await finishOperation(pool!, running, "succeeded");
  });

  test("refuses a SHA-256 or an actor that is not what it expects, before starting anything", async () => {
    for (const sha256 of ["nope", "A".repeat(64), `${SHA}; rm -rf /`, ""]) {
      await assert.rejects(launchApply({ pool: pool!, sha256, actor: ACTOR, dataDir: join(work, "var"), entry: [recorder()] }));
    }
    for (const actor of ["", "a b", "x;y", "--data-dir", "a".repeat(101), "$(id)"]) {
      await assert.rejects(launchApply({ pool: pool!, sha256: SHA, actor, dataDir: join(work, "var"), entry: [recorder()] }));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(existsSync(join(work, "args.json")), false);
  });
});
