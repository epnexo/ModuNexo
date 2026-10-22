import type { BrandProfile } from "@modunexo/core/brand";
import { CORE_VERSION } from "@modunexo/core/version";

/** Name, and for a business its public contact details; nothing at all while no identity is configured. */
export function BrandFooter({ profile }: { profile: BrandProfile | null }) {
  if (profile === null) return null;
  const year = new Date().getFullYear();
  const link = "underline-offset-4 hover:text-foreground hover:underline";
  return (
    <footer className="border-t border-border px-4 py-5 text-sm text-muted sm:px-8">
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-4 gap-y-1">
        <span>
          &copy; {year} {profile.name}
        </span>
        {profile.kind === "personal" && profile.email ? (
          <a href={`mailto:${profile.email}`} className={link}>
            {profile.email}
          </a>
        ) : null}
        {profile.kind === "business" ? (
          <>
            {profile.website ? (
              <a href={profile.website} target="_blank" rel="noopener noreferrer" className={link}>
                {profile.website.replace(/^https?:\/\//, "").replace(/\/$/, "")}
              </a>
            ) : null}
            <a href={`mailto:${profile.email}`} className={link}>
              {profile.email}
            </a>
            {profile.phone ? <span>{profile.phone}</span> : null}
          </>
        ) : null}
        <span className="sm:ml-auto">Modunexo {CORE_VERSION}</span>
      </div>
    </footer>
  );
}
