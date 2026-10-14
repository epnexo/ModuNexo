import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { superviseChild } from "../src/server/supervisor.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "epnexo-supervisor-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A child that records each start and then waits for a signal to stop, or exits by itself with a code. */
const childScript = (starts: string, exitCode?: number) => {
  const file = join(dir, `child-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(
    file,
    `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(starts)}, "start\\n");
${exitCode === undefined ? "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);" : `process.exit(${exitCode});`}
`,
  );
  return file;
};
const startsOf = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).length : 0);
const until = async (condition: () => boolean) => {
  for (let i = 0; i < 100 && !condition(); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(condition(), "condition was not met in time");
};

describe("superviseChild", () => {
  it("restarts the child when asked, and returns its exit code when it stops on its own", async () => {
    const starts = join(dir, "starts");
    const bus = new EventEmitter();
    const pidFile = join(dir, "run", "web.pid");
    const running = superviseChild({ args: [childScript(starts)], cwd: dir, pidFile, signals: bus });
    await until(() => startsOf(starts) === 1);
    assert.equal(readFileSync(pidFile, "utf8").trim(), String(process.pid), "the supervisor records its own pid");
    bus.emit("SIGUSR2");
    await until(() => startsOf(starts) === 2);
    bus.emit("SIGTERM");
    assert.equal(await running, 0);
    assert.equal(existsSync(pidFile), false, "the pid file is removed on the way out");
    assert.equal(startsOf(starts), 2);
  });

  it("a child that exits by itself is not restarted", async () => {
    const starts = join(dir, "starts");
    const code = await superviseChild({ args: [childScript(starts, 3)], cwd: dir, pidFile: join(dir, "web.pid"), signals: new EventEmitter() });
    assert.equal(code, 3);
    assert.equal(startsOf(starts), 1);
  });

  it("a restart request while it is already restarting does not start two children", async () => {
    const starts = join(dir, "starts");
    const bus = new EventEmitter();
    const running = superviseChild({ args: [childScript(starts)], cwd: dir, pidFile: join(dir, "web.pid"), signals: bus });
    await until(() => startsOf(starts) === 1);
    bus.emit("SIGUSR2");
    bus.emit("SIGUSR2");
    await until(() => startsOf(starts) >= 2);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(startsOf(starts), 2);
    bus.emit("SIGTERM");
    await running;
  });
});

describe("superviseChild: a child that will not stop", () => {
  it("is killed after the grace period so a restart cannot hang", async () => {
    const starts = join(dir, "starts");
    const stubborn = join(dir, "stubborn.mjs");
    writeFileSync(stubborn, `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(starts)}, "start\\n");\nprocess.on("SIGTERM", () => {});\nsetInterval(() => {}, 1000);\n`);
    const bus = new EventEmitter();
    const running = superviseChild({ args: [stubborn], cwd: dir, pidFile: join(dir, "web.pid"), signals: bus, killAfterMs: 300 });
    await until(() => startsOf(starts) === 1);
    bus.emit("SIGUSR2");
    await until(() => startsOf(starts) === 2);
    bus.emit("SIGTERM");
    await running;
  });
});
