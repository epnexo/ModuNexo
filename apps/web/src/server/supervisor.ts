import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "@modunexo/core/log";
import { exitCodeFor } from "./launch.ts";

/** What the supervisor listens on: `process`, or any emitter of the signal names in tests. */
export interface SignalSource {
  on(signal: NodeJS.Signals, handler: () => void): unknown;
  off(signal: NodeJS.Signals, handler: () => void): unknown;
}

export interface SuperviseOptions {
  /** Arguments for `node`. */
  args: string[];
  cwd: string;
  /** Where this process records its pid while it supervises, so another process can ask for a restart. */
  pidFile: string;
  /** Where the control signals come from; `process` in production. */
  signals: SignalSource;
  /** How long a child that was asked to stop may take before it is killed. Default 15 seconds. */
  killAfterMs?: number;
}

/**
 * Runs the server as a child and keeps it running across restarts: SIGUSR2 restarts it (after an install, so it
 * serves the new build), SIGINT and SIGTERM stop it and end this call. A child that exits on its own is not
 * started again: a crash or a refused start is reported by its exit code, never hidden by a loop.
 */
export function superviseChild(options: SuperviseOptions): Promise<number> {
  return new Promise((resolve) => {
    let child: ChildProcess | undefined;
    let stopping: NodeJS.Signals | null = null;
    let restarting = false;
    // A request that arrives while a restart is under way is kept: the build may have changed since that restart
    // began, so one more restart follows it. Requests are never dropped.
    let again = false;

    const cleanup = () => {
      for (const [signal, handler] of handlers) options.signals.off(signal, handler);
      rmSync(options.pidFile, { force: true });
    };

    const stop = (target: ChildProcess, signal: NodeJS.Signals) => {
      target.kill(signal);
      const timer = setTimeout(() => target.kill("SIGKILL"), options.killAfterMs ?? 15_000);
      target.once("exit", () => clearTimeout(timer));
    };

    const start = () => {
      const next = spawn(process.execPath, options.args, { cwd: options.cwd, stdio: "inherit" });
      child = next;
      next.on("error", (error) => {
        log.error("web.start_failed", { script: options.args[1] ?? "the web app", error });
        cleanup();
        resolve(1);
      });
      next.on("exit", (code, signal) => {
        if (child !== next) return;
        if (restarting && stopping === null) {
          restarting = false;
          start();
          if (again) {
            again = false;
            onRestart();
          }
          return;
        }
        if (signal !== null && signal !== stopping) log.error("web.killed", { signal });
        cleanup();
        resolve(exitCodeFor(code, signal, stopping));
      });
    };

    const onStop = (signal: NodeJS.Signals) => () => {
      stopping = signal;
      if (child !== undefined) stop(child, signal);
    };
    const onRestart = () => {
      if (stopping !== null || child === undefined) return;
      if (restarting) {
        again = true;
        return;
      }
      restarting = true;
      stop(child, "SIGTERM");
    };
    const handlers: [NodeJS.Signals, () => void][] = [
      ["SIGINT", onStop("SIGINT")],
      ["SIGTERM", onStop("SIGTERM")],
      ["SIGUSR2", onRestart],
    ];

    mkdirSync(dirname(options.pidFile), { recursive: true });
    writeFileSync(options.pidFile, `${process.pid}\n`);
    for (const [signal, handler] of handlers) options.signals.on(signal, handler);
    start();
  });
}
