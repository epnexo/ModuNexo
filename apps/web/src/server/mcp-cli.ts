import { spawn } from "node:child_process";
import type { McpRun } from "@modunexo/core/mcp-server";

export interface CliRunOptions {
  /** What follows `node`: the script and its own flags, as `apps-deps.ts` passes them. The argv is appended. */
  entry: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  timeoutMs?: number;
  /** The most the command may print, in bytes, both streams together. */
  maxBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BYTES = 1_048_576;

const lines = (text: string): string[] => (text === "" ? [] : text.replace(/\n$/, "").split("\n"));

/**
 * Runs a platform CLI command as a child process, the way the Apps screen does: a fixed program with the argv as
 * separate arguments (no shell), its output captured and bounded, and a time limit. The CLI is never imported into
 * the web bundle: it carries the module installer, which pulls the build tooling in with it.
 */
export function createCliRun(options: CliRunOptions): McpRun {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  return (argv, io) =>
    new Promise((resolve) => {
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let size = 0;
      let verdict: string | undefined;
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(process.execPath, [...options.entry, ...argv], { cwd: options.cwd, env: options.env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        io.err(`could not start the command: ${error instanceof Error ? error.message : String(error)}`);
        resolve(1);
        return;
      }
      const stop = (reason: string) => {
        if (verdict === undefined) verdict = reason;
        child.kill("SIGKILL");
      };
      const timer = setTimeout(() => stop(`the command timed out after ${Math.round(timeoutMs / 1000)} seconds`), timeoutMs);
      const keep = (into: Buffer[]) => (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) stop("the command printed too much output");
        else into.push(chunk);
      };
      child.stdout?.on("data", keep(out));
      child.stderr?.on("data", keep(err));
      child.once("error", (error) => {
        clearTimeout(timer);
        io.err(`could not start the command: ${error.message}`);
        resolve(1);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (verdict !== undefined) {
          io.err(verdict);
          resolve(1);
          return;
        }
        for (const line of lines(Buffer.concat(out).toString("utf8"))) io.out(line);
        for (const line of lines(Buffer.concat(err).toString("utf8"))) io.err(line);
        resolve(code ?? 1);
      });
    });
}
