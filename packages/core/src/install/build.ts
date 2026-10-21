import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { generateRegistration } from "../codegen/generate.ts";
import type { RegistrationModule } from "../codegen/render.ts";
import { distRecordPath, distTsconfigName, isDistName, readLiveDist, removeStrayDists, writeDistTsconfig, writeLiveDist } from "./dist.ts";

export interface BuildRunResult {
  code: number;
  /** The tail of what the build printed, for the operator. */
  output: string;
}
/**
 * Builds the web app in `webRoot` into the directory `dist` (a name from `dist.ts`; `.next` when omitted). Injectable so the
 * pipeline can be exercised without a real build.
 */
export type BuildRunner = (webRoot: string, signal?: AbortSignal, dist?: string) => Promise<BuildRunResult>;

export class BuildFailedError extends Error {
  readonly code: number;
  readonly output: string;
  constructor(code: number, output: string) {
    super(`the web build failed (exit code ${code}); its directory was removed and the registration restored, and the build that is serving was not touched`);
    this.name = "BuildFailedError";
    this.code = code;
    this.output = output;
  }
}

export interface BuildOptions {
  webRoot: string;
  /** Where the record of the live directory is kept. */
  dataDir: string;
  /** The directory this build writes. The caller names it so its journal can say which one to remove after a crash. */
  dist: string;
  /** What the web app is built with. */
  modules: RegistrationModule[];
  /** What it was built with before, so the registration can be put back. */
  previousModules: RegistrationModule[];
  run?: BuildRunner;
  /** Aborts the build; its directory and registration are then removed like after a failure. */
  signal?: AbortSignal;
}

export interface BuildHandle {
  /** The directory the new build is in. */
  dist: string;
  /** The new build goes live: the record names its directory. The server serves it from its next start. */
  commit: () => void;
  /** A later step failed: the new directory is removed and the previous registration comes back. */
  rollback: () => void;
}

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

/** The environment of a build into `dist`: the minimal one, plus the variable `next.config` reads the directory from. */
export function buildRunEnvironment(env: Record<string, string | undefined>, dist: string | undefined): NodeJS.ProcessEnv {
  const kept = buildEnvironment(env);
  if (dist !== undefined) kept.MODUNEXO_DIST_DIR = dist;
  return kept;
}

/** `next build` as the launcher runs it, in `webRoot`, with a minimal environment (see `buildEnvironment`). */
export const nextBuildRunner: BuildRunner = (webRoot, signal, dist) =>
  new Promise((resolve) => {
    const next = createRequire(import.meta.url).resolve("next/dist/bin/next");
    const child = spawn(process.execPath, [next, "build"], { cwd: webRoot, env: buildRunEnvironment(process.env, dist), stdio: ["ignore", "pipe", "pipe"] });
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
 * Registers `modules` with the web app and builds it into `options.dist`, next to the build that is serving, which is not
 * touched: the server keeps answering for the whole build. Nothing goes live until `commit`, which the caller makes after
 * its later steps have succeeded. A failed build removes its own directory and puts the previous registration back before
 * it throws, so the app is left as it was.
 *
 * Every build starts from an empty directory, with no cache from another build: Turbopack and TypeScript write their
 * cache in place, so sharing it between a kept build and a new one corrupted both. A cold build is slower and always right.
 */
export async function buildWithRollback(options: BuildOptions): Promise<BuildHandle> {
  const { webRoot, dataDir, dist } = options;
  if (!isDistName(dist)) throw new Error(`"${dist}" is not a build directory name`);
  const live = readLiveDist(webRoot, dataDir).name;
  if (dist === live) throw new Error(`${dist} is the live build directory: a build never writes over the one that is serving`);
  const runner = options.run ?? nextBuildRunner;

  // Directories nobody serves any more (an earlier switch, an earlier run that was not committed) go first, so they
  // do not pile up at 150 MB each; the one that is serving, and this one, stay.
  removeStrayDists(webRoot, [live, dist], { recordPath: distRecordPath(dataDir) });
  rmSync(join(webRoot, dist), { recursive: true, force: true });

  const discard = () => {
    rmSync(join(webRoot, dist), { recursive: true, force: true });
    rmSync(join(webRoot, distTsconfigName(dist)), { force: true });
    generateRegistration(options.previousModules, { outDir: webRoot });
  };

  let result: BuildRunResult;
  try {
    generateRegistration(options.modules, { outDir: webRoot });
    writeDistTsconfig(webRoot, dist);
    result = await runner(webRoot, options.signal, dist);
  } catch (error) {
    discard();
    throw error;
  }
  if (result.code !== 0) {
    discard();
    throw new BuildFailedError(result.code, result.output);
  }
  return {
    dist,
    commit: () => {
      if (!existsSync(join(webRoot, dist, "BUILD_ID"))) throw new Error(`${dist} has no BUILD_ID: it is not a finished build, so it is not put in service`);
      writeLiveDist(dataDir, dist);
    },
    rollback: discard,
  };
}
