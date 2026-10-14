import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import { OperationBusyError, liveOperation } from "../operations/index.ts";
import { assertSha256 } from "../packages/paths.ts";

/** Another run is alive; a second would only be refused by its lock, so it is not started. */
export class LaunchBusyError extends OperationBusyError {}

/** Who a run is recorded as: a short plain name, never something that could be read as an option. */
export const ACTOR = /^[A-Za-z0-9][A-Za-z0-9:._@-]{0,99}$/;

/** The process ended, with a failure, before the settle time was over; `output` is the end of what it printed. */
export class LaunchFailedError extends Error {
  readonly exitCode: number | null;
  readonly output: string;
  constructor(exitCode: number | null, output: string) {
    super(output === "" ? `the apply process ended with exit code ${exitCode}` : output);
    this.name = "LaunchFailedError";
    this.exitCode = exitCode;
    this.output = output;
  }
}

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
  /**
   * How long to wait, at most, to see whether the process ends right away. Refusals (the package is not newer, it
   * no longer passes) end it within a second or two and never create a run row, so without this the caller would
   * answer "started" for something that never ran. 0 (default) does not wait.
   */
  settleMs?: number;
}

export interface Launched {
  pid: number;
  logFile: string;
}

const MODULE_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** Starts `node <entry> <args>` detached, logging to `var/logs/`; see `launchApply`. */
async function launchProcess(options: Omit<LaunchOptions, "sha256" | "actor">, args: string[], label: string): Promise<Launched> {
  const running = await liveOperation(options.pool);
  if (running !== undefined) throw new LaunchBusyError(running);

  const logs = join(options.dataDir, "logs");
  mkdirSync(logs, { recursive: true, mode: 0o700 });
  const logFile = join(logs, `${label}-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
  const fd = openSync(logFile, "a", 0o600);
  try {
    const child = spawn(process.execPath, [...options.entry, ...args], {
      detached: true,
      stdio: ["ignore", fd, fd],
      env: options.env ?? process.env,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });
    const ended = new Promise<{ code: number | null; error?: Error }>((resolve) => {
      child.once("exit", (code) => resolve({ code }));
      child.once("error", (error) => resolve({ code: null, error }));
    });
    child.unref();
    if ((options.settleMs ?? 0) > 0 || child.pid === undefined) {
      let timer: NodeJS.Timeout | undefined;
      const outcome = await Promise.race([ended, new Promise<"running">((resolve) => (timer = setTimeout(() => resolve("running"), options.settleMs ?? 0)))]);
      if (timer !== undefined) clearTimeout(timer);
      if (outcome !== "running" && outcome.error !== undefined) throw new LaunchFailedError(null, `could not start the apply process: ${outcome.error.message}`);
      if (outcome !== "running" && outcome.code !== 0) {
        let output = "";
        try {
          output = readFileSync(logFile, "utf8").trim().split("\n").slice(-8).join("\n").slice(-1200);
        } catch {
          output = "";
        }
        throw new LaunchFailedError(outcome.code, output);
      }
    }
    if (child.pid === undefined) throw new Error("the apply process could not be started");
    return { pid: child.pid, logFile };
  } finally {
    closeSync(fd);
  }
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
  return launchProcess(options, ["modules", "apply", options.sha256, "--actor", options.actor, "--data-dir", options.dataDir], `apply-${options.sha256.slice(0, 12)}`);
}

export interface LaunchChangeOptions extends Omit<LaunchOptions, "sha256"> {
  moduleId: string;
  action: "enable" | "disable" | "uninstall";
  /** Required for `uninstall`. */
  mode?: "keep" | "purge";
}

/** Starts `modules <action> <id> --rebuild` detached, with the same rules as `launchApply`. */
export async function launchChange(options: LaunchChangeOptions): Promise<Launched> {
  if (!MODULE_ID.test(options.moduleId) || options.moduleId.length > 64) throw new Error("the module id is not a plain id");
  if (options.action !== "enable" && options.action !== "disable" && options.action !== "uninstall") throw new Error("the action is not one of enable, disable, uninstall");
  if (options.mode !== undefined && options.mode !== "keep" && options.mode !== "purge") throw new Error("the mode is not keep or purge");
  if (options.mode !== undefined && options.action !== "uninstall") throw new Error("a mode only applies to uninstall");
  if (!ACTOR.test(options.actor)) throw new Error("the actor is not a plain name");
  const mode = options.action === "uninstall" && options.mode !== undefined ? [`--${options.mode}`] : [];
  return launchProcess(options, ["modules", options.action, options.moduleId, "--rebuild", ...mode, "--actor", options.actor, "--data-dir", options.dataDir], `${options.action}-${options.moduleId}`);
}
