export const MAX_FILE_NAME_CHARS = 200;

/**
 * A file name as one harmless path segment: separators become `_`; control, invisible and direction-changing
 * characters go; at most 200 characters; never empty or only dots, which become "file". Nothing in a path or a header
 * is built from the name as the caller gave it.
 */
export function safeFileName(name: string): string {
  const clean = name
    .replace(/[\\/]/g, "_")
    .replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu, "")
    .trim();
  const cut = Array.from(clean).slice(0, MAX_FILE_NAME_CHARS).join("").trim();
  return /^[.\s]*$/.test(cut) ? "file" : cut;
}
