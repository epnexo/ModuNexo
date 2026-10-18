import { hkdfSync } from "node:crypto";

type Env = Record<string, string | undefined>;

/** The one secret the platform reads from the environment. Every other secret is derived from it or stored encrypted. */
export const MASTER_KEY_ENV = "MODUNEXO_MASTER_KEY";
/** The name the variable had before the project was renamed; still accepted so an existing `.env` keeps working. */
export const LEGACY_MASTER_KEY_ENV = "EPNEXO_MASTER_KEY";
export const MASTER_KEY_MIN_LENGTH = 32;

/** The master key is missing or too weak. The message never contains the key. */
export class MasterKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MasterKeyError";
  }
}

export function resolveMasterKey(env: Env = process.env): string {
  const fromNew = env[MASTER_KEY_ENV]?.trim() ?? "";
  const key = fromNew || env[LEGACY_MASTER_KEY_ENV]?.trim() || "";
  const variable = fromNew ? MASTER_KEY_ENV : LEGACY_MASTER_KEY_ENV;
  if (key === "") {
    throw new MasterKeyError(`${MASTER_KEY_ENV} is not set (${LEGACY_MASTER_KEY_ENV}, its old name, is also accepted). Generate one with "openssl rand -base64 48" and add it to .env.`);
  }
  if (key.length < MASTER_KEY_MIN_LENGTH) {
    throw new MasterKeyError(`${variable} must be at least ${MASTER_KEY_MIN_LENGTH} characters; it has ${key.length}.`);
  }
  return key;
}

/**
 * A secret for one purpose, derived from the master key with HKDF-SHA256. Each consumer asks for its own purpose,
 * so a leak of one derived secret exposes neither the master key nor the others.
 *
 * The `epnexo:` prefix is part of the derivation, not a label: it is what the stored secrets and the sessions were
 * made with before the project was renamed Modunexo. Changing it would make every stored secret undecryptable, so it
 * stays (a test pins the derived values).
 */
export function deriveSecret(masterKey: string, purpose: string): string {
  if (purpose === "") throw new Error("deriveSecret needs a non-empty purpose");
  return Buffer.from(hkdfSync("sha256", masterKey, "", `epnexo:${purpose}`, 32)).toString("hex");
}
