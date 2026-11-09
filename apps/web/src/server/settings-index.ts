/** What the search over Settings knows about one setting: where it lives and how to describe it. Never a value. */
export interface SettingsIndexEntry {
  label: string;
  /** The help text the setting already shows on its own screen. */
  description: string;
  /** The module's name, or "General" for the platform's own sections. */
  where: string;
  href: string;
}

interface IndexedModule {
  id: string;
  name: string;
  settings?: readonly { label: string; description?: string }[];
}

/** The tabs of Settings that belong to the platform and not to a module. */
export const GENERAL_SETTINGS = [
  { label: "Profile", description: "The name and logo of this platform.", href: "/settings#profile" },
  { label: "Appearance", description: "Accent color, corners and theme.", href: "/settings#appearance" },
  { label: "Security", description: "Trusted proxies and how sign-in is protected.", href: "/settings#security" },
  { label: "MCP", description: "Connect an assistant to this platform.", href: "/settings#mcp" },
] as const;

/**
 * Every setting an administrator can reach, built from what the modules declare, so it needs no database and cannot hold
 * a value: only a label, its help text and a link. Modules that are not enabled have no settings screen and are left out.
 */
export function buildSettingsIndex(modules: readonly IndexedModule[], enabled: ReadonlySet<string>): SettingsIndexEntry[] {
  const general = GENERAL_SETTINGS.map((entry): SettingsIndexEntry => ({ ...entry, where: "General" }));
  const owned = modules
    .filter((module) => enabled.has(module.id))
    .flatMap((module) =>
      (module.settings ?? []).map((setting): SettingsIndexEntry => ({
        label: setting.label,
        description: setting.description ?? "",
        where: module.name,
        href: `/settings?module=${encodeURIComponent(module.id)}#modules`,
      })),
    );
  return [...general, ...owned];
}

/** The entries whose label, help text or module name contain the query, ignoring case; nothing for a blank query. */
export function searchSettings(index: readonly SettingsIndexEntry[], query: string, limit = 8): SettingsIndexEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [];
  return index.filter((entry) => `${entry.label} ${entry.description} ${entry.where}`.toLowerCase().includes(needle)).slice(0, limit);
}
