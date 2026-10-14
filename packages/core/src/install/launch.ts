import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import { OperationBusyError, liveOperation } from "../operations/index.ts";
import { assertSha256 } from "../packages/paths.ts";

/** Another run is alive; a second would only be refused by its lock, so it is not started. */
export class LaunchBusyError extends OperationBusyError {}

/** Who a run is recorded as: a short plain name, never something that could be read as an option. */
export const ACTOR = /^[A-Za-z0-9][A-Za-z0-9:._@-]{0,99}$/;

export interface LaunchOptions {
  pool: pg.Pool;
  sha256: string;
  actor: string;
  dataDir: string;
  /**
   * What to run after `node`: the script and its own flags, e.g. `["--import", "tsx", "<repo>/packages/core/src/cli/index.ts"]`.
   * The command is `modules apply <sha256> --actor <actor> --data-dir <dir>` appended to it.
   */
  entry: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface Launched {
  pid: number;
  logFile: string;
}

/**
 * Starts `modules apply` for a staged package as a process of its own: detached from the caller (an apply restarts
 * the server that asked for it, and must outlive it), with its output in `var/logs/`. The command is built from a
 * fixed program and validated values and never goes through a shell. The caller gets the pid and the log file; the
 * run itself is followed through `core.module_operations`.
 */
export async function launchApply(options: LaunchOptions): Promise<Launched> {
  assertSha256(options.sha256);
  if (!ACTOR.test(options.actor)) throw new Error("the actor is not a plain name");
  const running = await liveOperation(options.pool);
  if (running !== undefined) throw new LaunchBusyError(running);

  const logs = join(options.dataDir, "logs");
  mkdirSync(logs, { recursive: true, mode: 0o700 });
  const logFile = join(logs, `apply-${new Date().toISOString().replace(/[:.]/g, "-")}-${options.sha256.slice(0, 12)}.log`);
  const fd = openSync(logFile, "a", 0o600);
  try {
    const child = spawn(
      process.execPath,
      [...options.entry, "modules", "apply", options.sha256, "--actor", options.actor, "--data-dir", options.dataDir],
      { detached: true, stdio: ["ignore", fd, fd], env: options.env ?? process.env, ...(options.cwd === undefined ? {} : { cwd: options.cwd }) },
    );
    child.unref();
    if (child.pid === undefined) throw new Error("the apply process could not be started");
    return { pid: child.pid, logFile };
  } finally {
    closeSync(fd);
  }
}
