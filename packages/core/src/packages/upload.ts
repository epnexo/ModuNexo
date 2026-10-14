import { randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type pg from "pg";
import { ARCHIVE_LIMITS } from "./archive.ts";
import { type IntakeResult, intakePackage } from "./intake.ts";
import type { PackageContext } from "./validate.ts";

/** The body went past the size the platform accepts for an archive. */
export class UploadTooLargeError extends Error {
  readonly limit: number;
  constructor(limit: number) {
    super(`the upload is larger than ${limit} bytes`);
    this.name = "UploadTooLargeError";
    this.limit = limit;
  }
}

export interface UploadOptions {
  pool: pg.Pool;
  /** The request body. */
  body: ReadableStream<Uint8Array>;
  dataDir: string;
  context: PackageContext;
  actor: string;
  expectedSha256?: string;
  /** Default: the archive limit of intake. */
  maxBytes?: number;
}

/**
 * Receives an archive sent over the network and brings it in through intake. The body is written under
 * `<dataDir>/uploads/` under a name the platform makes, counted as it arrives and abandoned the moment it passes
 * the limit, so a sender cannot make the server hold or write more than that. The upload file is always removed;
 * intake keeps its own copy under the archive's SHA-256.
 */
export async function receiveUpload(options: UploadOptions): Promise<IntakeResult> {
  const limit = options.maxBytes ?? ARCHIVE_LIMITS.archiveBytes;
  const uploads = join(options.dataDir, "uploads");
  mkdirSync(uploads, { recursive: true, mode: 0o700 });
  const file = join(uploads, `.upload-${randomBytes(8).toString("hex")}.tgz`);
  let received = 0;
  try {
    await pipeline(
      Readable.fromWeb(options.body as Parameters<typeof Readable.fromWeb>[0]),
      new Transform({
        transform(chunk: Buffer, _encoding, done) {
          received += chunk.length;
          if (received > limit) done(new UploadTooLargeError(limit));
          else done(null, chunk);
        },
      }),
      createWriteStream(file, { mode: 0o600 }),
    );
    return await intakePackage({
      pool: options.pool,
      archive: file,
      dataDir: options.dataDir,
      context: options.context,
      actor: options.actor,
      ...(options.expectedSha256 === undefined ? {} : { expectedSha256: options.expectedSha256 }),
    });
  } finally {
    rmSync(file, { force: true });
  }
}
