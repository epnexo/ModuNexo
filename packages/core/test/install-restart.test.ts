import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { LAUNCHER_MARKER, pidFilePath, requestRestart } from "../src/install/restart.ts";

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "epnexo-restart-"));
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

const writePid = (content: string) => {
  mkdirSync(join(dataDir, "run"), { recursive: true });
  writeFileSync(pidFilePath(dataDir), content);
};
const launcher = `node\0--import\0tsx\0/repo/${LAUNCHER_MARKER}\0start\0`;

describe("requestRestart", () => {
  it("says so when no server recorded itself, and signals nothing", async () => {
    const signals: unknown[] = [];
    const message = await requestRestart({ dataDir, kill: (...args) => void signals.push(args) });
    assert.match(message, /no web server/i);
    assert.deepEqual(signals, []);
  });

  it("signals the launcher whose pid is recorded, once", async () => {
    writePid("4242\n");
    const signals: unknown[] = [];
    const message = await requestRestart({ dataDir, kill: (pid, signal) => void signals.push([pid, signal]), readCmdline: () => launcher });
    assert.deepEqual(signals, [[4242, "SIGUSR2"]]);
    assert.match(message, /4242/);
  });

  it("does not signal a process that is not the launcher (a recycled pid)", async () => {
    writePid("4242\n");
    const signals: unknown[] = [];
    const message = await requestRestart({ dataDir, kill: (...args) => void signals.push(args), readCmdline: () => "sshd\0-D\0" });
    assert.deepEqual(signals, []);
    assert.match(message, /not the web launcher|stale/i);
  });

  it("does not signal the launcher's build or dev commands, which also run apps/web/scripts/run.ts", async () => {
    writePid("4242\n");
    for (const command of ["build", "dev"]) {
      const signals: unknown[] = [];
      const message = await requestRestart({ dataDir, kill: (...args) => void signals.push(args), readCmdline: () => `node\0--import\0tsx\0/repo/${LAUNCHER_MARKER}\0${command}\0` });
      assert.deepEqual(signals, [], command);
      assert.match(message, /not the web launcher|stale/i);
    }
  });

  it("does not signal when the process is gone or the file is not a pid", async () => {
    writePid("4242\n");
    const none: unknown[] = [];
    assert.match(await requestRestart({ dataDir, kill: (...a) => void none.push(a), readCmdline: () => null }), /not running|stale/i);
    writePid("; rm -rf /\n");
    assert.match(await requestRestart({ dataDir, kill: (...a) => void none.push(a), readCmdline: () => launcher }), /pid file/i);
    writePid("-1");
    await requestRestart({ dataDir, kill: (...a) => void none.push(a), readCmdline: () => launcher });
    assert.deepEqual(none, []);
  });
});
