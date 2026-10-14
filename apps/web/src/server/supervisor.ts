import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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

    const cleanup = () => {
      for (const [signal, handler] of handlers) options.signals.off(signal, handler);
      rmSync(options.pidFile, { force: true });
    };

    const start = () => {
      const next = spawn(process.execPath, options.args, { cwd: options.cwd, stdio: "inherit" });
      child = next;
      next.on("error", (error) => {
        console.error(`error: could not start ${options.args[1] ?? "the web app"}: ${error.message}`);
        cleanup();
        resolve(1);
      });
      next.on("exit", (code, signal) => {
        if (child !== next) return;
        if (restarting && stopping === null) {
          restarting = false;
          start();
          return;
        }
        if (signal !== null && signal !== stopping) console.error(`error: the web app process was killed by ${signal}`);
        cleanup();
        resolve(exitCodeFor(code, signal, stopping));
      });
    };

    const onStop = (signal: NodeJS.Signals) => () => {
      stopping = signal;
      child?.kill(signal);
    };
    const onRestart = () => {
      if (restarting || stopping !== null || child === undefined) return;
      restarting = true;
      child.kill("SIGTERM");
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
