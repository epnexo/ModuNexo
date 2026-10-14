import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";
import { generateRegistration } from "../codegen/generate.ts";
import type { RegistrationModule } from "../codegen/render.ts";

const run = promisify(execFile);

export interface BuildRunResult {
  code: number;
  /** The tail of what the build printed, for the operator. */
  output: string;
}
/** Builds the web app in `webRoot`. Injectable so the pipeline can be exercised without a real build. */
export type BuildRunner = (webRoot: string, signal?: AbortSignal) => Promise<BuildRunResult>;

export class BuildFailedError extends Error {
  readonly code: number;
  readonly output: string;
  constructor(code: number, output: string) {
    super(`the web build failed (exit code ${code}); the previous build and registration were restored`);
    this.name = "BuildFailedError";
    this.code = code;
    this.output = output;
  }
}

export interface BuildOptions {
  webRoot: string;
  /** What the web app is built with. */
  modules: RegistrationModule[];
  /** What it was built with before, so the registration can be put back. */
  previousModules: RegistrationModule[];
  run?: BuildRunner;
  /** Aborts the build; the previous build and registration are then restored like after a failure. */
  signal?: AbortSignal;
}

export interface BuildHandle {
  /** The new build is final: the kept previous build is removed. */
  commit: () => void;
  /** A later step failed: the previous build and registration come back. */
  rollback: () => void;
}

const BACKUP = ".next.rollback";
const OUTPUT_TAIL = 6000;
const BUILD_TIMEOUT_MS = 30 * 60 * 1000;

/** `next build` as the launcher runs it, in `webRoot`, with the environment of this process. */
export const nextBuildRunner: BuildRunner = (webRoot, signal) =>
  new Promise((resolve) => {
    const next = createRequire(import.meta.url).resolve("next/dist/bin/next");
    const child = spawn(process.execPath, [next, "build"], { cwd: webRoot, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-OUTPUT_TAIL);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => child.kill("SIGKILL"), BUILD_TIMEOUT_MS);
    const abort = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 1, output: `could not start next build: ${error.message}` });
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output: signal === null ? output : `${output}\nkilled by ${signal}` });
    });
  });

/**
 * Registers `modules` with the web app and builds it, keeping the previous `.next` (moved aside, with its build cache
 * linked back so the build stays incremental) until `commit`. A failed build restores the previous build and the
 * previous registration before it throws, so the app is left as it was.
 */
export async function buildWithRollback(options: BuildOptions): Promise<BuildHandle> {
  const dist = join(options.webRoot, ".next");
  const backup = join(options.webRoot, BACKUP);
  const runner = options.run ?? nextBuildRunner;
  let hadBuild = false;

  const restore = () => {
    rmSync(dist, { recursive: true, force: true });
    if (hadBuild && existsSync(backup)) renameSync(backup, dist);
    generateRegistration(options.previousModules, { outDir: options.webRoot });
  };

  rmSync(backup, { recursive: true, force: true });
  if (existsSync(dist)) {
    // The previous build is moved aside whole, so nothing the new build writes can touch it. Only the build cache
    // is linked back into the new `.next`, so the build stays incremental.
    renameSync(dist, backup);
    hadBuild = true;
    mkdirSync(dist);
    if (existsSync(join(backup, "cache"))) await run("cp", ["-al", join(backup, "cache"), join(dist, "cache")]);
  }
  let result: BuildRunResult;
  try {
    generateRegistration(options.modules, { outDir: options.webRoot });
    result = await runner(options.webRoot, options.signal);
  } catch (error) {
    restore();
    throw error;
  }
  if (result.code !== 0) {
    restore();
    throw new BuildFailedError(result.code, result.output);
  }
  return {
    commit: () => rmSync(backup, { recursive: true, force: true }),
    rollback: restore,
  };
}
