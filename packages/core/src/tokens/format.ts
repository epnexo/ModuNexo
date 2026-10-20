import { createHash, randomBytes } from "node:crypto";

const TOKEN = /^mdnx_([0-9a-f]{8})_([A-Za-z0-9_-]{43})$/;

/** A new token and the parts the platform stores: its lookup prefix and the SHA-256 of the whole text. */
export function generateToken(random: (size: number) => Buffer = randomBytes): { token: string; prefix: string; hash: string } {
  const prefix = random(4).toString("hex");
  const token = `mdnx_${prefix}_${random(32).toString("base64url")}`;
  return { token, prefix, hash: hashToken(token) };
}

export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

/** The lookup prefix of a well-formed token, or null. Anything else is not a token this platform issued. */
export function tokenPrefix(token: string): string | null {
  const match = TOKEN.exec(token);
  return match === null ? null : match[1]!;
}
