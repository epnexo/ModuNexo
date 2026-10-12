import { hkdfSync } from "node:crypto";

type Env = Record<string, string | undefined>;

/** The one secret the platform reads from the environment. Every other secret is derived from it or stored encrypted. */
export const MASTER_KEY_ENV = "EPNEXO_MASTER_KEY";
export const MASTER_KEY_MIN_LENGTH = 32;

/** The master key is missing or too weak. The message never contains the key. */
export class MasterKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MasterKeyError";
  }
}

export function resolveMasterKey(env: Env = process.env): string {
  const key = env[MASTER_KEY_ENV]?.trim() ?? "";
  if (key === "") {
    throw new MasterKeyError(`${MASTER_KEY_ENV} is not set. Generate one with "openssl rand -base64 48" and add it to .env.`);
  }
  if (key.length < MASTER_KEY_MIN_LENGTH) {
    throw new MasterKeyError(`${MASTER_KEY_ENV} must be at least ${MASTER_KEY_MIN_LENGTH} characters; it has ${key.length}.`);
  }
  return key;
}

/**
 * A secret for one purpose, derived from the master key with HKDF-SHA256. Each consumer asks for its own purpose,
 * so a leak of one derived secret exposes neither the master key nor the others.
 */
export function deriveSecret(masterKey: string, purpose: string): string {
  if (purpose === "") throw new Error("deriveSecret needs a non-empty purpose");
  return Buffer.from(hkdfSync("sha256", masterKey, "", `epnexo:${purpose}`, 32)).toString("hex");
}
