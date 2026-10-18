import { type BrandProfile, initialsOf } from "@modunexo/core/brand";

export const DEFAULT_BRAND_NAME = "Modunexo";

export function brandName(profile: BrandProfile | null): string {
  return profile === null ? DEFAULT_BRAND_NAME : profile.name;
}

/**
 * The identity at a glance: the logo or photo when there is one, else a monogram (initials on the person's color,
 * or on the accent for a business), and the default name when nothing is configured. The image URL carries the
 * file's hash so a replaced logo is never shown stale.
 */
export function BrandMark({ profile, logo, size = 28, showName = true }: { profile: BrandProfile | null; logo: string | null; size?: number; showName?: boolean }) {
  if (profile === null) return <span className="font-semibold tracking-tight">{DEFAULT_BRAND_NAME}</span>;
  const frame = { width: size, height: size };
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      {logo !== null ? (
        // eslint-disable-next-line @next/next/no-img-element -- a stored, hashed, same-origin file
        <img src={`/api/brand/logo?v=${logo}`} alt="" style={frame} className="shrink-0 rounded-md object-contain" />
      ) : (
        <span
          aria-hidden
          style={{ ...frame, fontSize: size * 0.4, background: profile.kind === "personal" ? `oklch(0.55 0.15 ${profile.monogramHue})` : "var(--accent)" }}
          className="grid shrink-0 place-items-center rounded-md font-semibold text-white"
        >
          {initialsOf(profile.name)}
        </span>
      )}
      {showName ? <span className="truncate font-semibold tracking-tight">{profile.name}</span> : <span className="sr-only">{profile.name}</span>}
    </span>
  );
}
