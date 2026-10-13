import { createHash, randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ManifestError, type ModuleManifest, validateManifest } from "@epnexo/sdk";
import * as tar from "tar";
import { ARCHIVE_LIMITS } from "./archive.ts";
import { type PackageContext, type PackageReview, validatePackageTree } from "./validate.ts";

/** The folder every archive holds, like `npm pack`. */
const TOP_LEVEL = "package";

/** Names that never travel: dependencies, history, build output, local secrets, other archives, editor litter. */
function isExcluded(name: string): boolean {
  return (
    name === "node_modules" || name === ".git" || name === ".next" || name === ".turbo" || name === ".DS_Store" || name === ".env" || name.startsWith(".env.") || name.endsWith(".tgz")
  );
}

export class PackRefusedError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(problems.join("\n"));
    this.name = "PackRefusedError";
    this.problems = problems;
  }
}

export interface PackResult {
  outFile: string;
  sizeBytes: number;
  sha256: string;
  manifest: ModuleManifest;
  review: PackageReview;
}

/** Copies the folder without what is excluded; returns the relative paths of the files it copied, sorted. */
function copyTree(source: string, destination: string, problems: string[], relative = ""): string[] {
  const copied: string[] = [];
  const entries = readdirSync(join(source, relative), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const entry of entries) {
    if (isExcluded(entry.name)) continue;
    const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
    const from = join(source, path);
    const stat = lstatSync(from);
    if (stat.isSymbolicLink()) problems.push(`"${path}" is a symbolic link, which a package may not contain`);
    else if (stat.isDirectory()) {
      mkdirSync(join(destination, path), { recursive: true });
      copied.push(...copyTree(source, destination, problems, path));
    } else if (stat.isFile()) {
      copyFileSync(from, join(destination, path));
      // Reproducible: only whether a file is executable is kept, never who owned it or what its mode was.
      chmodSync(join(destination, path), stat.mode & 0o111 ? 0o755 : 0o644);
      copied.push(path);
    } else problems.push(`"${path}" is not a regular file or a folder`);
  }
  return copied;
}

/**
 * Loads the author's manifest.ts. That file is the author's own code, evaluated on the author's machine: this is
 * the one place a manifest is executed, so that the archive can carry it as data (manifest.json).
 */
async function loadManifest(folder: string): Promise<ModuleManifest> {
  const file = join(folder, "manifest.ts");
  let loaded: { default?: unknown };
  try {
    loaded = await import(pathToFileURL(file).href);
  } catch (error) {
    throw new PackRefusedError([`manifest.ts could not be loaded: ${error instanceof Error ? error.message : String(error)}`]);
  }
  if (loaded.default === undefined) throw new PackRefusedError(["manifest.ts must have a default export with the module manifest"]);
  try {
    return validateManifest(loaded.default);
  } catch (error) {
    throw new PackRefusedError([`manifest.ts is not a valid manifest: ${error instanceof ManifestError ? error.message : String(error)}`]);
  }
}

/**
 * Builds the archive a platform accepts from a module folder: the sources, with manifest.json written next to
 * manifest.ts, under one top-level folder, in a stable order and without owners or timestamps, so the same folder
 * always gives the same bytes. The package is validated first against this platform, so an author finds problems
 * here and not on the machine that receives it. Nothing is written unless it is valid, and the folder is not touched.
 */
export async function packFolder(folder: string, context: PackageContext, out?: string): Promise<PackResult> {
  const source = resolve(folder);
  if (!existsSync(source) || !statSync(source).isDirectory()) throw new PackRefusedError([`"${folder}" is not a folder`]);
  if (!existsSync(join(source, "manifest.ts"))) throw new PackRefusedError([`"${folder}" has no manifest.ts`]);

  const manifest = await loadManifest(source);

  const work = mkdtempSync(join(tmpdir(), "epnexo-pack-"));
  try {
    const staged = join(work, TOP_LEVEL);
    mkdirSync(staged);
    const problems: string[] = [];
    const files = copyTree(source, staged, problems);
    if (problems.length > 0) throw new PackRefusedError(problems);

    writeFileSync(join(staged, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
    if (!files.includes("manifest.json")) files.push("manifest.json");

    const validation = validatePackageTree(staged, context);
    if (!validation.ok) throw new PackRefusedError(validation.problems);
    if (files.length > ARCHIVE_LIMITS.files) throw new PackRefusedError([`the package has ${files.length} files; the platform accepts at most ${ARCHIVE_LIMITS.files}`]);

    const target = resolve(out ?? `${validation.review.id}-${validation.review.version}.tgz`);
    mkdirSync(dirname(target), { recursive: true });
    const partial = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString("hex")}.part`);
    try {
      await tar.create(
        { file: partial, cwd: work, gzip: { level: 9 }, portable: true, mtime: new Date(0), noPax: true },
        files.sort().map((path) => `${TOP_LEVEL}/${path}`),
      );
      renameSync(partial, target);
    } finally {
      rmSync(partial, { force: true });
    }
    const bytes = readFileSync(target);
    return { outFile: target, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), manifest, review: validation.review };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
