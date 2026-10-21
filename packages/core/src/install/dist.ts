import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The directory `next build` writes when nothing says otherwise, and the one a deployment that never changed a module serves. */
export const DEFAULT_DIST = ".next";
const DIST_NAME = /^\.next(-[a-zA-Z0-9]{1,24})?$/;
const DIST_TSCONFIG = /^tsconfig(\.next-[a-zA-Z0-9]{1,24})\.json$/;
/** A server that has just been replaced may still be draining for this long and reading its own directory. */
export const SWITCH_GRACE_MS = 60_000;

/** `.next`, or `.next-` and letters and digits: a name that is one folder inside the web app and cannot point anywhere else. */
export const isDistName = (name: string): boolean => DIST_NAME.test(name);

const assertDistName = (name: string): void => {
  if (!isDistName(name)) throw new Error(`"${name}" is not a build directory name`);
};

/** A name for the build of one run: the time and a few random characters, so two runs never share a directory. */
export function newDistName(now: () => number = Date.now, random: () => string = () => Math.random().toString(36).slice(2, 6).padEnd(4, "0")): string {
  return `${DEFAULT_DIST}-${now().toString(36)}${random()}`;
}

/** Where the name of the live directory is kept: next to the pid file and the journal, in the data directory. */
export const distRecordPath = (dataDir: string): string => join(dataDir, "run", "web.dist");

export interface LiveDist {
  name: string;
  /** Whether a record exists at all. */
  recorded: boolean;
  /** Why the record was not followed (the name is then `.next`); null when it was, or when there is none. */
  reason: string | null;
}

/**
 * The directory the server should serve: the one the record names, if it is a finished build, otherwise `.next`. A record
 * that is missing, empty, not a build directory name, or points at a directory that is gone or half built (a container
 * recreated from its image, a run that died) never stops the server from starting.
 */
export function readLiveDist(webRoot: string, dataDir: string): LiveDist {
  let text: string;
  try {
    text = readFileSync(distRecordPath(dataDir), "utf8").trim();
  } catch {
    return { name: DEFAULT_DIST, recorded: false, reason: null };
  }
  const fallback = (reason: string): LiveDist => ({ name: DEFAULT_DIST, recorded: true, reason });
  if (text === "") return fallback("the record is empty");
  if (!isDistName(text)) return fallback(`"${text}" is not a build directory name`);
  if (!existsSync(join(webRoot, text))) return fallback(`${text} does not exist`);
  if (!existsSync(join(webRoot, text, "BUILD_ID"))) return fallback(`${text} has no BUILD_ID: it is an unfinished build`);
  return { name: text, recorded: true, reason: null };
}

/** Makes `name` the live directory, all at once: a reader sees the old record or the new one, never half of one. */
export function writeLiveDist(dataDir: string, name: string): void {
  assertDistName(name);
  const file = distRecordPath(dataDir);
  mkdirSync(dirname(file), { recursive: true });
  const partial = `${file}.part`;
  writeFileSync(partial, `${name}\n`);
  renameSync(partial, file);
}

/** The file `next build` type-checks a directory with: `tsconfigPath` in next.config names it from the directory's name. */
export const distTsconfigName = (dist: string): string => `tsconfig${dist}.json`;

/**
 * The app's tsconfig names `.next/types` by path, so a build into another directory would type-check the types of the build
 * that is serving, which name pages a change may have removed. This writes a tsconfig for `dist` that names only its own
 * types. The default directory needs none (null).
 */
export function writeDistTsconfig(webRoot: string, dist: string): string | null {
  assertDistName(dist);
  if (dist === DEFAULT_DIST) return null;
  const base = JSON.parse(readFileSync(join(webRoot, "tsconfig.json"), "utf8")) as { include?: string[] };
  const include = (base.include ?? []).filter((entry) => !entry.startsWith(`${DEFAULT_DIST}/`) && !entry.startsWith(`${DEFAULT_DIST}-`));
  const file = join(webRoot, distTsconfigName(dist));
  writeFileSync(file, `${JSON.stringify({ extends: "./tsconfig.json", include: [...include, `${dist}/types/**/*.ts`] }, null, 2)}\n`);
  return file;
}

export interface StrayOptions {
  /** The record of the live directory: if it was written less than `graceMs` ago nothing is removed. */
  recordPath?: string;
  graceMs?: number;
  now?: () => number;
}

/**
 * Removes the build directories (and their tsconfig files) that are not in `keep`. Returns what it removed. A link is
 * removed, never followed. After a switch it removes nothing for a minute: the server that was replaced may still be
 * draining and reading its own files.
 */
export function removeStrayDists(webRoot: string, keep: readonly string[], options: StrayOptions = {}): string[] {
  if (!existsSync(webRoot)) return [];
  if (options.recordPath !== undefined) {
    try {
      if ((options.now ?? Date.now)() - statSync(options.recordPath).mtimeMs < (options.graceMs ?? SWITCH_GRACE_MS)) return [];
    } catch {
      // No record yet: nothing was switched.
    }
  }
  const removed: string[] = [];
  for (const name of readdirSync(webRoot)) {
    const tsconfig = DIST_TSCONFIG.exec(name);
    const stray = tsconfig === null ? isDistName(name) && !keep.includes(name) : !keep.includes(tsconfig[1]!);
    if (!stray) continue;
    rmSync(join(webRoot, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}
