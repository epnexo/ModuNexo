import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { deriveSecret } from "../auth/master-key.ts";

/** The module and setting a secret belongs to. It is authenticated with the ciphertext, so a token cannot be moved. */
export interface SecretSlot {
  moduleId: string;
  key: string;
}

/** A stored secret cannot be decrypted: another master key, a changed token or a moved one. The message names the slot only. */
export class SecretUnreadableError extends Error {
  constructor(slot: SecretSlot) {
    super(`the secret "${slot.key}" of module "${slot.moduleId}" cannot be read: it was encrypted under another master key or was changed`);
    this.name = "SecretUnreadableError";
  }
}

const VERSION = "v1";
const IV_BYTES = 12;

const dataKey = (masterKey: string): Buffer => Buffer.from(deriveSecret(masterKey, "settings"), "hex");
const aad = (slot: SecretSlot): Buffer => Buffer.from(`${slot.moduleId}\u0000${slot.key}`, "utf8");

/**
 * AES-256-GCM under a key derived from the master key, with the module and key as associated data. The token is
 * `v1.<iv>.<tag>.<ciphertext>`, each part base64url, and a fresh random IV makes every token different.
 */
export function encryptSecret(masterKey: string, slot: SecretSlot, plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", dataKey(masterKey), iv);
  cipher.setAAD(aad(slot));
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}

export function decryptSecret(masterKey: string, slot: SecretSlot, token: string): string {
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) throw new SecretUnreadableError(slot);
  try {
    const decipher = createDecipheriv("aes-256-gcm", dataKey(masterKey), Buffer.from(parts[1]!, "base64url"));
    decipher.setAAD(aad(slot));
    decipher.setAuthTag(Buffer.from(parts[2]!, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(parts[3]!, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new SecretUnreadableError(slot);
  }
}
