import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where the platform keeps what it receives and unpacks: `var/` at the repository root, or `EPNEXO_DATA_DIR` when
 * it is set (tests and unusual deployments). Not tracked by git.
 */
export const DATA_DIR = process.env.EPNEXO_DATA_DIR ? resolve(process.env.EPNEXO_DATA_DIR) : resolve(dirname(fileURLToPath(import.meta.url)), "../../../../var");

const SHA256 = /^[0-9a-f]{64}$/;

/** A SHA-256 as 64 lowercase hexadecimal characters. Anything else is refused, so a hash can never be a path. */
export function assertSha256(value: string): void {
  if (!SHA256.test(value)) throw new Error("a SHA-256 is 64 lowercase hexadecimal characters");
}

export function archivePath(dataDir: string, sha256: string): string {
  assertSha256(sha256);
  return join(dataDir, "packages", `${sha256}.tgz`);
}

export function stagingPath(dataDir: string, sha256: string): string {
  assertSha256(sha256);
  return join(dataDir, "staging", sha256);
}
