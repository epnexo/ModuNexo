import { spawn } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { generateRegistration } from "../codegen/generate.ts";
import type { RegistrationModule } from "../codegen/render.ts";

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

/** What a build may see of the environment: tools, locale and Next's own settings. Never the master key or a database URL. */
const BUILD_ENV_KEYS = ["PATH", "HOME", "USER", "LANG", "LANGUAGE", "TZ", "TMPDIR", "NODE_OPTIONS", "NODE_ENV", "CI", "WEB_PUBLIC_URL"];
const BUILD_ENV_PREFIXES = ["LC_", "NEXT_", "TURBOPACK"];

export function buildEnvironment(env: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const kept = {} as NodeJS.ProcessEnv;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (BUILD_ENV_KEYS.includes(key) || BUILD_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) kept[key] = value;
  }
  return kept;
}

/** `next build` as the launcher runs it, in `webRoot`, with a minimal environment (see `buildEnvironment`). */
export const nextBuildRunner: BuildRunner = (webRoot, signal) =>
  new Promise((resolve) => {
    const next = createRequire(import.meta.url).resolve("next/dist/bin/next");
    const child = spawn(process.execPath, [next, "build"], { cwd: webRoot, env: buildEnvironment(process.env), stdio: ["ignore", "pipe", "pipe"] });
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
 * Registers `modules` with the web app and builds it from a clean `.next`, keeping the previous one (moved aside,
 * untouched) until `commit`. A failed build restores the previous build and the
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
    // The previous build is moved aside whole, so nothing the new build writes can touch it, and the new build
    // starts from an empty `.next`. Its cache is deliberately not carried over: Turbopack and TypeScript write the
    // cache in place, so sharing it (as links) between the kept build and the new one corrupted both, and builds
    // failed with errors about files that exist. A cold build is slower and always right.
    renameSync(dist, backup);
    hadBuild = true;
    mkdirSync(dist);
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
