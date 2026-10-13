import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ModuleManifest } from "@epnexo/sdk";
import type pg from "pg";
import semver from "semver";
import { ARCHIVE_LIMITS, type ArchiveLimits, stageArchive } from "./archive.ts";
import { DATA_DIR, archivePath, assertSha256, stagingPath } from "./paths.ts";
import { recordIntake } from "./store.ts";
import { type PackageContext, type PackageReview, validatePackageTree } from "./validate.ts";

export interface IntakeOptions {
  pool: pg.Pool;
  /** The archive on disk. It is copied; the original is never modified or moved. */
  archive: string;
  /** A SHA-256 the publisher gave. When present the archive must match it exactly. */
  expectedSha256?: string;
  /** Who is bringing it, recorded with the intake. */
  actor: string;
  dataDir?: string;
  limits?: ArchiveLimits;
  context: PackageContext;
}

export type IntakeResult =
  | { ok: true; sha256: string; sizeBytes: number; manifest: ModuleManifest; review: PackageReview; stagingDir: string; archiveFile: string; alreadyStaged: boolean }
  | { ok: false; sha256: string; sizeBytes: number; problems: string[] };

const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/**
 * The id and version of a package whose manifest.json could be read, for the audit record of a refusal. They come
 * from an untrusted file and are stored only when they have the shape of an id and of a version; otherwise null.
 */
function peekIdentity(root: string): { moduleId: string | null; version: string | null } {
  try {
    const path = join(root, "manifest.json");
    if (!lstatSync(path).isFile() || statSync(path).size > 1024 * 1024) return { moduleId: null, version: null };
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof raw !== "object" || raw === null) return { moduleId: null, version: null };
    const { id, version } = raw as Record<string, unknown>;
    return {
      moduleId: typeof id === "string" && id.length <= 64 && KEBAB.test(id) ? id : null,
      version: typeof version === "string" && version.length <= 64 && semver.valid(version) !== null ? version : null,
    };
  } catch {
    return { moduleId: null, version: null };
  }
}

/**
 * Brings an archive into the platform and stops there. It is copied into the data folder while it is hashed (and
 * all later work reads the copy, so the file cannot change under it), inspected, unpacked into a staging folder
 * and validated as data; the outcome is recorded either way. A refusal leaves no archive and no tree behind, and
 * nothing the package contains is imported, executed, built or installed.
 */
export async function intakePackage(options: IntakeOptions): Promise<IntakeResult> {
  const dataDir = options.dataDir ?? DATA_DIR;
  const limits = options.limits ?? ARCHIVE_LIMITS;
  const expected = options.expectedSha256?.toLowerCase();
  if (expected !== undefined) assertSha256(expected);
  if (!statSync(options.archive).isFile()) throw new Error(`"${options.archive}" is not a file`);

  const packagesDir = join(dataDir, "packages");
  mkdirSync(packagesDir, { recursive: true, mode: 0o700 });
  const incoming = join(packagesDir, `.incoming-${randomBytes(8).toString("hex")}`);
  const hash = createHash("sha256");
  let sizeBytes = 0;
  try {
    await pipeline(
      createReadStream(options.archive),
      new Transform({
        transform(chunk: Buffer, _encoding, done) {
          hash.update(chunk);
          sizeBytes += chunk.length;
          done(null, chunk);
        },
      }),
      createWriteStream(incoming, { mode: 0o600 }),
    );
  } catch (error) {
    rmSync(incoming, { force: true });
    throw error;
  }
  const sha256 = hash.digest("hex");

  const stored = archivePath(dataDir, sha256);
  const staging = stagingPath(dataDir, sha256);
  let createdArchive = false;
  let createdStaging = false;
  const discard = () => {
    if (createdStaging) rmSync(staging, { recursive: true, force: true });
    if (createdArchive) rmSync(stored, { force: true });
    rmSync(incoming, { force: true });
  };
  const refuse = async (problems: string[], identity: { moduleId: string | null; version: string | null } = { moduleId: null, version: null }): Promise<IntakeResult> => {
    await recordIntake(options.pool, { sha256, moduleId: identity.moduleId, version: identity.version, sizeBytes, status: "refused", problems, actor: options.actor });
    return { ok: false, sha256, sizeBytes, problems };
  };

  if (expected !== undefined && expected !== sha256) {
    discard();
    return refuse([`the archive's SHA-256 is ${sha256}, not the expected ${expected}`]);
  }

  let alreadyStaged = false;
  if (existsSync(staging) && existsSync(stored)) {
    alreadyStaged = true;
    rmSync(incoming, { force: true });
  } else {
    if (existsSync(stored)) rmSync(incoming, { force: true });
    else {
      renameSync(incoming, stored);
      createdArchive = true;
    }
    rmSync(staging, { recursive: true, force: true });
    try {
      const staged = await stageArchive(stored, staging, limits);
      if (!staged.ok) {
        discard();
        return refuse(staged.problems);
      }
      createdStaging = true;
    } catch (error) {
      discard();
      throw error;
    }
  }

  const validation = validatePackageTree(staging, options.context);
  if (!validation.ok) {
    const identity = peekIdentity(staging);
    // A package that was already staged and passed before is left where it is; a new one is removed.
    discard();
    return refuse(validation.problems, identity);
  }

  await recordIntake(options.pool, {
    sha256,
    moduleId: validation.review.id,
    version: validation.review.version,
    sizeBytes,
    status: "staged",
    problems: null,
    actor: options.actor,
  });
  return { ok: true, sha256, sizeBytes, manifest: validation.manifest, review: validation.review, stagingDir: staging, archiveFile: stored, alreadyStaged };
}
