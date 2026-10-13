/** One sidebar entry, as the generated registry carries it. */
export interface NavEntry {
  moduleId: string;
  label: string;
  href: string;
  icon?: string;
  group?: string;
  order?: number;
  permission?: string;
}

export interface NavGroup {
  /** The group's heading; null for entries that declare no group. */
  label: string | null;
  entries: NavEntry[];
}

/** Who is looking: the local operator (sign-in is off) or a signed-in user with a role. */
export type Subject = { kind: "operator" } | { kind: "user"; role: string | null | undefined };

/** Whether the subject may see an entry that names a permission. The only role the shell knows is `admin`. */
export function subjectCan(subject: Subject, permission: string | undefined): boolean {
  if (permission === undefined) return true;
  return subject.kind === "operator" || subject.role === "admin";
}

/**
 * The entries the subject may see, grouped under their heading in the order the registry gave them (ungrouped
 * first, then by group, order and label). A group whose entries are all hidden disappears with them.
 */
export function groupNavigation(entries: readonly NavEntry[], canUse: (permission: string | undefined) => boolean): NavGroup[] {
  const groups = new Map<string | null, NavGroup>();
  for (const entry of entries) {
    if (!canUse(entry.permission)) continue;
    const label = entry.group ?? null;
    const group = groups.get(label) ?? { label, entries: [] };
    group.entries.push(entry);
    groups.set(label, group);
  }
  return [...groups.values()];
}

/** The entry is the current page when the path is its own or below it; the home entry matches only the root. */
export function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(href.endsWith("/") ? href : `${href}/`);
}

/** The icons a manifest may name. Anything else gets the generic one, so a typo never breaks the sidebar. */
export const ICON_NAMES = ["app", "home", "apps", "settings", "dashboard", "documents", "chart", "megaphone", "users", "database", "mail", "calendar", "folder", "shield", "bolt"] as const;
export type IconName = (typeof ICON_NAMES)[number];

export function resolveIcon(name: string | undefined): IconName {
  return name !== undefined && (ICON_NAMES as readonly string[]).includes(name) ? (name as IconName) : "app";
}
