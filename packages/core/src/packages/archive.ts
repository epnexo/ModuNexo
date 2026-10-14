import { chmodSync, createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { Parser, extract } from "tar";

export interface ArchiveLimits {
  /** Size of the compressed archive on disk, in bytes. */
  archiveBytes: number;
  /** Sum of the sizes of everything in it once unpacked, in bytes. */
  unpackedBytes: number;
  /** Files and folders together. */
  files: number;
  /** Length of a whole path inside the archive. */
  pathLength: number;
}

export const ARCHIVE_LIMITS: ArchiveLimits = {
  archiveBytes: 50 * 1024 * 1024,
  unpackedBytes: 200 * 1024 * 1024,
  files: 5000,
  pathLength: 255,
};

export interface ArchiveEntry {
  /** As stored; a folder ends with a slash. */
  path: string;
  type: "file" | "dir";
  size: number;
}

export type Inspection =
  | { ok: true; root: string; entries: ArchiveEntry[]; unpackedBytes: number }
  | { ok: false; problems: string[] };

const MAX_PROBLEMS = 50;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

const KINDS: Record<string, string> = {
  SymbolicLink: "symbolic link",
  Link: "hard link",
  CharacterDevice: "device",
  BlockDevice: "device",
  FIFO: "special file",
};

/** What is wrong with a name, if anything. Names are shown quoted, with control characters made visible. */
function pathProblem(path: string, limits: ArchiveLimits): string | null {
  const shown = JSON.stringify(path);
  if (CONTROL.test(path)) return `${shown}: control characters are not allowed in a path`;
  if (path.includes("\\")) return `${shown}: backslashes are not allowed in a path`;
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return `${shown}: absolute paths are not allowed`;
  if (path.length > limits.pathLength) return `${shown}: the path is too long (over ${limits.pathLength} characters)`;
  const segments = path.split("/").filter((segment) => segment !== "");
  if (segments.includes("..")) return `${shown}: a path must not contain a ".." segment`;
  if (segments.includes(".")) return `${shown}: a path must not contain a "." segment`;
  const hidden = segments.find((segment) => ["node_modules", ".git"].includes(segment.toLowerCase()));
  if (hidden !== undefined) return `${shown}: ${hidden.toLowerCase()} is not accepted in a package`;
  return null;
}

class TooBig extends Error {}

/** What the parser tells the counter. */
interface ParserState {
  /** The parser saw the end-of-archive marker: it ignores everything after it, and so does the extractor. */
  eof: boolean;
}

/**
 * Counts what flows through and stops the pipeline when it passes a ceiling, so a bomb is never read to the end.
 * Once the parser has reported the end-of-archive marker (`eof`) what follows is counted and dropped: the parser,
 * and the extractor with it, ignore it, but the parser is not linear in it, so a few hundred kilobytes of gzip that
 * inflate to hundreds of megabytes of zeros would otherwise keep it busy for minutes. Nothing before the marker is
 * ever dropped, so every entry the extractor would write has been inspected.
 */
const counter = (ceiling: number, state: ParserState) => {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      seen += chunk.length;
      if (seen > ceiling) return done(new TooBig());
      if (state.eof) return done();
      done(null, chunk);
    },
  });
};

/**
 * Reads an archive's table of contents without writing anything and without keeping any file's content, and says
 * what is wrong with it. The rules are the ones a package must meet before any of it touches the disk: one
 * top-level folder; only files and folders; no absolute path, `..`, links, devices or duplicate names; no
 * `node_modules` or `.git`; and the limits. Every problem found is returned, up to a cap.
 */
export async function inspectArchive(file: string, limits: ArchiveLimits = ARCHIVE_LIMITS): Promise<Inspection> {
  const problems: string[] = [];
  const note = (problem: string) => {
    if (problems.length < MAX_PROBLEMS) problems.push(problem);
  };

  const onDisk = statSync(file).size;
  if (onDisk > limits.archiveBytes) return { ok: false, problems: [`the archive is ${onDisk} bytes, over the limit of ${limits.archiveBytes}`] };

  const entries: ArchiveEntry[] = [];
  const seen = new Set<string>();
  const roots = new Set<string>();
  let unpacked = 0;
  let count = 0;
  let overFiles = false;
  let overBytes = false;

  const state: ParserState = { eof: false };
  const parser = new Parser({
    // Report every entry exactly as stored (nothing here is ever written), so that each refusal can name its entry
    // instead of the parser quietly dropping it.
    preservePaths: true,
    onwarn: (_code: string, message: string) => note(`the archive is damaged: ${message}`),
    onReadEntry: (entry) => {
      count += 1;
      entry.resume();
      if (count > limits.files) {
        overFiles = true;
        return;
      }
      const path = String(entry.path);
      const kind = KINDS[entry.type];
      if (kind !== undefined) {
        note(`${JSON.stringify(path)}: a ${kind} is not allowed`);
        return;
      }
      if (entry.type !== "File" && entry.type !== "Directory") {
        note(`${JSON.stringify(path)}: entries of type ${entry.type} are not allowed`);
        return;
      }
      const problem = pathProblem(path, limits);
      if (problem !== null) {
        note(problem);
        return;
      }
      const segments = path.split("/").filter((segment) => segment !== "");
      const isDir = entry.type === "Directory";
      if (segments.length === 0) return;
      roots.add(segments[0]!);
      if (!isDir && segments.length === 1) note(`${JSON.stringify(path)}: files must be inside a folder`);
      const key = segments.join("/").toLowerCase();
      if (seen.has(key)) note(`${JSON.stringify(path)}: is a duplicate (names are compared without regard to letter case)`);
      seen.add(key);
      const size = isDir ? 0 : Number(entry.size);
      unpacked += size;
      if (unpacked > limits.unpackedBytes) overBytes = true;
      entries.push({ path: isDir ? `${segments.join("/")}/` : segments.join("/"), type: isDir ? "dir" : "file", size });
    },
  });

  parser.on("eof", () => {
    state.eof = true;
  });

  // Headers and padding are not counted in the declared sizes, so the ceiling leaves room for them.
  const ceiling = limits.unpackedBytes + Math.min(limits.files * 1024, 8 * 1024 * 1024) + 1024 * 1024;
  try {
    await pipeline(createReadStream(file), createGunzip(), counter(ceiling, state), parser);
  } catch (error) {
    if (error instanceof TooBig) overBytes = true;
    else note(`it is not a readable gzip tarball: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (overFiles) note(`the archive has more than ${limits.files} entries`);
  if (overBytes) note(`the unpacked size exceeds ${limits.unpackedBytes} bytes`);
  if (count === 0 && !problems.some((problem) => problem.startsWith("it is not a readable"))) {
    problems.length = 0;
    note("the archive is empty");
  }
  if (roots.size > 1) note(`a package has exactly one top-level folder; this one has ${roots.size}: ${[...roots].map((r) => JSON.stringify(r)).join(", ")}`);
  if (problems.length >= MAX_PROBLEMS) problems.push("(more problems were found and are not listed)");
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, root: [...roots][0]!, entries, unpackedBytes: unpacked };
}

export type StageResult = Inspection;

/** Files 0644 and folders 0755, whatever the archive said: nothing it brings is executable or writable by others. */
function normalizeModes(root: string): void {
  chmodSync(root, 0o755);
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (lstatSync(path).isDirectory()) normalizeModes(path);
    else chmodSync(path, 0o644);
  }
}

/**
 * Inspects an archive and, only if it passes, unpacks it without its top-level folder into `destination`, which
 * must not exist. Modes are normalised afterwards (files 0644, folders 0755, so nothing is executable or setuid)
 * and the tree is written into a temporary sibling and renamed into place, so a failure leaves nothing at
 * `destination`.
 */
export async function stageArchive(file: string, destination: string, limits: ArchiveLimits = ARCHIVE_LIMITS): Promise<StageResult> {
  if (existsSync(destination)) throw new Error(`"${destination}" already exists`);
  const inspection = await inspectArchive(file, limits);
  if (!inspection.ok) return inspection;

  mkdirSync(dirname(destination), { recursive: true });
  const temporary = mkdtempSync(join(dirname(destination), ".incoming-"));
  try {
    await extract({
      file,
      cwd: temporary,
      strip: 1,
      strict: true,
      preservePaths: false,
      umask: 0o022,
      filter: (_path, entry) => ("type" in entry ? entry.type === "File" || entry.type === "Directory" : true),
    });
    normalizeModes(temporary);
    renameSync(temporary, destination);
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
  return inspection;
}
