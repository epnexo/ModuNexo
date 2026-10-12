import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { compareIds } from "../registry.ts";
import { GENERATED_HEADER, RegistrationError, type RegistrationModule, type RenderedFile, renderRegistration } from "./render.ts";

/** The web app the registration is generated for; it is built by a later feature, so tests inject their own root. */
export const DEFAULT_WEB_ROOT = fileURLToPath(new URL("../../../../apps/web", import.meta.url));

/** The generator's record of what it wrote, relative to the web app root. */
export const OWNERSHIP_FILE = "src/generated/.manifest.json";

const GENERATOR = "@epnexo/core registry:generate";
const ROUTE_FILE_NAMES = ["page.tsx", "page.ts", "page.jsx", "page.js", "page.mdx", "route.ts", "route.tsx", "route.js", "route.jsx"];

export interface PlannedWrite {
  /** Relative to `root`, with forward slashes. */
  path: string;
  content: string;
  change: "create" | "update";
}

/** What a run does (or, for a dry run, would do). Paths are relative to `root`. */
export interface GenerationPlan {
  root: string;
  writes: PlannedWrite[];
  /** Files the generator owns whose content is already right. */
  unchanged: string[];
  /** Stale generated files that are removed. */
  deletions: string[];
  /** Things the run left alone on purpose, such as a listed file that is no longer generated. */
  warnings: string[];
}

export interface GenerateOptions {
  /** The web app root. Default `DEFAULT_WEB_ROOT`. */
  outDir?: string;
  /** Plan only: return the writes and deletions without touching the filesystem. */
  dryRun?: boolean;
  /** Replaces the reserved shell paths; see `RESERVED_PATHS`. */
  reservedPaths?: readonly string[];
}

const ownershipContent = (packages: string[], files: string[]): string =>
  `${JSON.stringify({ generator: GENERATOR, version: 1, packages, files }, null, 2)}\n`;

/** The text of a generated source file starts with the header; that is how the generator recognises its own files. */
const isGenerated = (content: string): boolean => content.startsWith(GENERATED_HEADER);

/** Read a file when there is one; `undefined` when absent. A directory is reported, not read. */
function readIfPresent(root: string, path: string, problems: string[]): string | undefined {
  const absolute = join(root, path);
  if (!existsSync(absolute)) return undefined;
  if (statSync(absolute).isDirectory()) {
    problems.push(`"${path}" is a directory, but the generator needs a file there`);
    return undefined;
  }
  return readFileSync(absolute, "utf8");
}

function readOwnership(root: string): string[] | undefined {
  const absolute = join(root, OWNERSHIP_FILE);
  if (!existsSync(absolute)) return undefined;
  const invalid = new RegistrationError([`"${OWNERSHIP_FILE}" is not a valid ownership manifest; delete it (and the generated files it lists) to start over`]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolute, "utf8"));
  } catch {
    throw invalid;
  }
  const record = parsed as { generator?: unknown; files?: unknown } | null;
  const files = record?.files;
  const safe = (file: unknown): file is string => typeof file === "string" && file !== "" && !isAbsolute(file) && !file.includes("\\") && !file.split("/").some((s) => s === ".." || s === "." || s === "");
  if (record?.generator !== GENERATOR || !Array.isArray(files) || !files.every(safe)) throw invalid;
  return files as string[];
}

/** A plan with what only the run itself needs: the manifest texts and the listed files that are no longer wanted. */
interface RunPlan extends GenerationPlan {
  /** Everything the previous manifest listed or this run would own, so an interrupted run leaves nothing unlisted. */
  interimOwnership: string;
  finalOwnership: string;
  /** Listed files that are no longer wanted, present or not: their folders are pruned even when the file is already gone. */
  retired: string[];
}

/**
 * Decide what a run does, reading the filesystem but never writing it. Throws `RegistrationError` before
 * anything could be written when the modules cannot be registered (see `renderRegistration`) or when a path the
 * generator needs holds something it did not generate.
 */
function plan(modules: RegistrationModule[], root: string, reservedPaths: readonly string[] | undefined): RunPlan {
  const rendered = renderRegistration(modules, reservedPaths === undefined ? {} : { reservedPaths });
  const previous = readOwnership(root);
  const problems: string[] = [];

  const wanted = new Map(rendered.files.map((f) => [f.path, f.content]));
  const owned = [...wanted.keys()].sort(compareIds);
  const ownership: RenderedFile = { path: OWNERSHIP_FILE, content: ownershipContent(rendered.packages, owned) };
  const stale = new Set((previous ?? []).filter((file) => !wanted.has(file)));

  const writes: PlannedWrite[] = [];
  const unchanged: string[] = [];
  const warnings: string[] = [];
  for (const file of [...rendered.files, ownership]) {
    const existing = readIfPresent(root, file.path, problems);
    if (existing !== undefined && file !== ownership && !isGenerated(existing)) {
      problems.push(`"${file.path}" already exists and was not generated by registry:generate; move or remove it`);
    }
    if (existing === file.content) unchanged.push(file.path);
    else writes.push({ path: file.path, content: file.content, change: existing === undefined ? "create" : "update" });

    // A page and a route (or two extensions) in one folder make Next.js fail, so a hand-written sibling is a clash too.
    if (file.path.startsWith("src/app/")) {
      for (const sibling of ROUTE_FILE_NAMES.filter((name) => name !== basename(file.path))) {
        const rival = posix.join(posix.dirname(file.path), sibling);
        const content = readIfPresent(root, rival, problems);
        if (content === undefined) continue;
        if (isGenerated(content)) stale.add(rival);
        else problems.push(`"${rival}" would clash with generated "${file.path}" (one folder cannot hold both); move or remove it`);
      }
    }
  }
  if (problems.length > 0) throw new RegistrationError(problems);

  const deletions: string[] = [];
  for (const file of [...stale].sort(compareIds)) {
    const content = readIfPresent(root, file, problems);
    if (content === undefined) continue;
    if (isGenerated(content)) deletions.push(file);
    else warnings.push(`"${file}" is listed as generated but was not generated by registry:generate (its header is gone); left in place`);
  }
  if (problems.length > 0) throw new RegistrationError(problems);

  // Deletions include generated siblings that were never listed; listing them first keeps them findable.
  const interim = [...new Set([...(previous ?? []), ...owned, ...deletions])].sort(compareIds);
  return {
    root,
    writes,
    unchanged,
    deletions,
    warnings,
    interimOwnership: ownershipContent(rendered.packages, interim),
    finalOwnership: ownership.content,
    retired: [...stale].sort(compareIds),
  };
}

/** Write through a temporary file in the same folder, so a reader never sees half a file. */
function writeAtomically(absolute: string, content: string): void {
  mkdirSync(dirname(absolute), { recursive: true });
  const temporary = `${absolute}.tmp-${process.pid}`;
  writeFileSync(temporary, content);
  renameSync(temporary, absolute);
}

/** Remove the folders a deletion emptied, from the file's folder up to, and not including, `src/app`. */
function pruneEmptyFolders(root: string, deleted: string): void {
  const stop = join(root, "src/app");
  for (let dir = dirname(join(root, deleted)); dir.startsWith(`${stop}/`); dir = dirname(dir)) {
    // A folder that is already gone (an earlier run removed it) is not a reason to stop: its parent may be empty now.
    if (existsSync(dir)) {
      // Something that is not a folder (a hand-written file in the way) is not ours to touch, and ends the climb.
      if (!statSync(dir).isDirectory() || readdirSync(dir).length > 0) return;
      rmdirSync(dir);
    }
  }
}

/**
 * Turn the enabled modules into the files the web app needs, under `outDir`, and remove what a previous run
 * generated that is no longer wanted. Everything the run owns is recorded in `src/generated/.manifest.json`.
 *
 * Conflicts, a path held by a hand-written file and an unreadable ownership manifest are all found before the
 * first write and reported as one `RegistrationError`. The run is idempotent: files whose content is already
 * right are not touched. With `dryRun` the plan is returned and the filesystem is not touched at all.
 *
 * A run that throws partway (a write, a deletion or a folder removal) is not atomic, but it is recoverable: see
 * the comment on the ownership manifest below. Running the generator again converges to the correct tree.
 */
export function generateRegistration(modules: RegistrationModule[], options: GenerateOptions = {}): GenerationPlan {
  const root = options.outDir ?? DEFAULT_WEB_ROOT;
  const { interimOwnership, finalOwnership, retired, ...result } = plan(modules, root, options.reservedPaths);
  if (options.dryRun === true) return result;

  // Ownership is recorded in two steps so that a run that dies partway can always be cleaned up by the next one.
  // First the manifest lists everything the previous one listed plus everything this run is about to create or
  // remove; only after the writes, the deletions and the folder pruning have all succeeded is it rewritten to the
  // exact final list. Until then the manifest is a superset, so no file a failed run touched is ever unlisted, and
  // the next run deletes whatever in that superset is no longer wanted (and prunes the folders it left empty).
  const manifestPath = join(root, OWNERSHIP_FILE);
  let recorded = existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : undefined;
  const record = (content: string): void => {
    if (content === recorded) return;
    writeAtomically(manifestPath, content);
    recorded = content;
  };
  record(interimOwnership);
  for (const write of result.writes) if (write.path !== OWNERSHIP_FILE) writeAtomically(join(root, write.path), write.content);
  for (const file of result.deletions) rmSync(join(root, file));
  for (const file of retired) pruneEmptyFolders(root, file);
  record(finalOwnership);
  return result;
}
