import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where the platform keeps what it receives and unpacks: `var/` at the repository root, or `MODUNEXO_DATA_DIR` when
 * it is set (tests and unusual deployments). `EPNEXO_DATA_DIR`, the name before the rename, is still accepted. Not
 * tracked by git.
 */
export function resolveDataDir(env: Record<string, string | undefined> = process.env): string {
  const chosen = env.MODUNEXO_DATA_DIR || env.EPNEXO_DATA_DIR;
  return chosen ? resolve(chosen) : resolve(dirname(fileURLToPath(import.meta.url)), "../../../../var");
}

export const DATA_DIR = resolveDataDir();

const SHA256 = /^[0-9a-f]{64}$/;

/** A SHA-256 as 64 lowercase hexadecimal characters. Anything else is refused, so a hash can never be a path. */
export function assertSha256(value: string): void {
  if (!SHA256.test(value)) throw new Error("a SHA-256 is 64 lowercase hexadecimal characters");
}

export function archivePath(dataDir: string, sha256: string): string {
  assertSha256(sha256);
  return join(dataDir, "packages", `${sha256}.tgz`);
}

/** Where the platform keeps the files modules store through the SDK (the disk adapter's root). */
export function filesDir(dataDir: string): string {
  return join(dataDir, "files");
}

export function stagingPath(dataDir: string, sha256: string): string {
  assertSha256(sha256);
  return join(dataDir, "staging", sha256);
}
