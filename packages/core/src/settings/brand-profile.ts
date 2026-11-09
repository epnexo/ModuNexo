// Browser-safe part of the brand code: it imports no Node module, so a client component can use it without bundling a
// crypto polyfill (`brand.ts` imports `node:crypto`).

/** Up to two initials for a monogram: first letters of the first and last words. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter((word) => word !== "");
  if (words.length === 0) return "?";
  const first = Array.from(words[0]!)[0]!;
  const last = words.length > 1 ? Array.from(words[words.length - 1]!)[0]! : "";
  return (first + last).toUpperCase();
}
