import { createHash } from "node:crypto";

export const BRAND_KINDS = ["business", "personal"] as const;
export type BrandKind = (typeof BRAND_KINDS)[number];

export const MAX_IMAGE_BYTES = 512 * 1024;
export type ImageType = "image/png" | "image/jpeg" | "image/webp";

export interface BusinessProfile {
  kind: "business";
  name: string;
  representative: string;
  email: string;
  website?: string;
  phone?: string;
  taxId?: string;
  address?: string;
}

export interface PersonalProfile {
  kind: "personal";
  name: string;
  /** Hue (0-360) of the generated monogram shown when there is no photo. */
  monogramHue: number;
}

export type BrandProfile = BusinessProfile | PersonalProfile;

export type Checked<T> = { ok: true; value: T } | { ok: false; message: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function text(input: unknown, label: string, max: number, required: boolean): Checked<string | undefined> {
  if (input === undefined || input === null || (typeof input === "string" && input.trim() === "")) {
    return required ? { ok: false, message: `${label} is required` } : { ok: true, value: undefined };
  }
  if (typeof input !== "string") return { ok: false, message: `${label} must be text` };
  const value = input.trim();
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return { ok: false, message: `${label} cannot contain control characters` };
  if (value.length > max) return { ok: false, message: `${label} is longer than ${max} characters` };
  return { ok: true, value };
}

/** Validates a profile as the administrator sent it; the first problem is the answer. Unknown fields are ignored. */
export function validateProfile(input: unknown): Checked<BrandProfile> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, message: "the profile must be an object" };
  const raw = input as Record<string, unknown>;
  if (raw.kind !== "business" && raw.kind !== "personal") return { ok: false, message: 'kind must be "business" or "personal"' };

  const name = text(raw.name, raw.kind === "business" ? "the business name" : "the name", 80, true);
  if (!name.ok) return name;

  if (raw.kind === "personal") {
    const hue = raw.monogramHue === undefined ? 250 : raw.monogramHue;
    if (typeof hue !== "number" || !Number.isInteger(hue) || hue < 0 || hue > 360) return { ok: false, message: "the monogram color must be a whole number from 0 to 360" };
    return { ok: true, value: { kind: "personal", name: name.value!, monogramHue: hue } };
  }

  const representative = text(raw.representative, "the legal representative", 80, true);
  if (!representative.ok) return representative;
  const email = text(raw.email, "the contact email", 254, true);
  if (!email.ok) return email;
  if (!EMAIL.test(email.value!)) return { ok: false, message: "the contact email is not a valid address" };

  const website = text(raw.website, "the website", 200, false);
  if (!website.ok) return website;
  if (website.value !== undefined) {
    let url: URL | null = null;
    try {
      url = new URL(website.value);
    } catch {
      url = null;
    }
    if (url === null || (url.protocol !== "https:" && url.protocol !== "http:")) return { ok: false, message: "the website must be a full http or https address" };
  }
  const phone = text(raw.phone, "the phone", 40, false);
  if (!phone.ok) return phone;
  const taxId = text(raw.taxId, "the tax id", 40, false);
  if (!taxId.ok) return taxId;
  const address = text(raw.address, "the address", 200, false);
  if (!address.ok) return address;

  const profile: BusinessProfile = { kind: "business", name: name.value!, representative: representative.value!, email: email.value! };
  if (website.value !== undefined) profile.website = website.value;
  if (phone.value !== undefined) profile.phone = phone.value;
  if (taxId.value !== undefined) profile.taxId = taxId.value;
  if (address.value !== undefined) profile.address = address.value;
  return { ok: true, value: profile };
}

/** What an image really is, from its first bytes; the name or the declared type of an upload prove nothing. */
export function sniffImage(bytes: Uint8Array): ImageType | null {
  const starts = (signature: number[], at = 0) => signature.every((byte, i) => bytes[at + i] === byte);
  if (bytes.length >= 8 && starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (bytes.length >= 3 && starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (bytes.length >= 12 && starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return null;
}

export function validateImage(bytes: Uint8Array): Checked<{ contentType: ImageType; sha256: string }> {
  if (bytes.length === 0) return { ok: false, message: "the image is empty" };
  if (bytes.length > MAX_IMAGE_BYTES) return { ok: false, message: `the image is larger than ${MAX_IMAGE_BYTES / 1024} KB` };
  const contentType = sniffImage(bytes);
  if (contentType === null) return { ok: false, message: "the image must be a PNG, JPEG or WebP file" };
  return { ok: true, value: { contentType, sha256: createHash("sha256").update(bytes).digest("hex") } };
}

/** Up to two initials for a monogram: first letters of the first and last words. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter((word) => word !== "");
  if (words.length === 0) return "?";
  const first = Array.from(words[0]!)[0]!;
  const last = words.length > 1 ? Array.from(words[words.length - 1]!)[0]! : "";
  return (first + last).toUpperCase();
}
