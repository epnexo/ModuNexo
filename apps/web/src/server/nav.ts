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

/**
 * Whether the subject may see an entry that names a permission. The local operator (sign-in disabled), an
 * `admin` and an `operator` hold every module permission; any other role holds none. What only an administrator may
 * do (apps, settings, identity) is not a module permission: it is checked where it happens (`canWrite`).
 */
export function subjectCan(subject: Subject, permission: string | undefined): boolean {
  if (permission === undefined) return true;
  return subject.kind === "operator" || subject.role === "admin" || subject.role === "operator";
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

/** The groups an administrator manages, and which module sits in which. */
export interface GroupLayout {
  groups: readonly { id: number; name: string; position: number }[];
  /** Module id to group id. */
  assignments: Readonly<Record<string, number>>;
}

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Lays the registry's entries over the managed groups. A module sits under the group it was assigned; one nobody
 * assigned keeps the group its manifest declares, and joins the managed group of the same name (ignoring case) if
 * there is one. Order: ungrouped first, then the managed groups in the administrator's order, then the manifests'
 * own groups by name; inside a group by `order` (none last), label and module id.
 */
export function arrangeNavigation(entries: readonly NavEntry[], layout: GroupLayout): NavEntry[] {
  const byId = new Map(layout.groups.map((group) => [group.id, group]));
  const byName = new Map(layout.groups.map((group) => [group.name.toLowerCase(), group]));
  const placed = entries.map((entry) => {
    const assigned = byId.get(layout.assignments[entry.moduleId] ?? -1);
    const managed = assigned ?? (entry.group === undefined ? undefined : byName.get(entry.group.toLowerCase()));
    return { entry: managed === undefined ? entry : { ...entry, group: managed.name }, rank: managed === undefined ? (entry.group === undefined ? -1 : Number.POSITIVE_INFINITY) : managed.position };
  });
  return placed
    .sort(
      (a, b) =>
        (a.rank === b.rank ? 0 : a.rank < b.rank ? -1 : 1) ||
        compareText(a.entry.group ?? "", b.entry.group ?? "") ||
        (a.entry.order ?? Number.POSITIVE_INFINITY) - (b.entry.order ?? Number.POSITIVE_INFINITY) ||
        compareText(a.entry.label, b.entry.label) ||
        compareText(a.entry.moduleId, b.entry.moduleId),
    )
    .map((item) => item.entry);
}

/** The entry is the current page when the path is its own or below it; the home entry matches only the root. */
export function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(href.endsWith("/") ? href : `${href}/`);
}

/** The current page is one of the group's entries or below one. */
export function groupHasActive(group: NavGroup, pathname: string): boolean {
  return group.entries.some((entry) => isActive(pathname, entry.href));
}

/** The names of the collapsed groups as the browser stored them; anything that is not a list of names counts as none. */
export function parseCollapsed(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) && value.every((item) => typeof item === "string") ? [...new Set(value as string[])] : [];
  } catch {
    return [];
  }
}

export function toggleCollapsed(collapsed: readonly string[], label: string): string[] {
  const rest = [...new Set(collapsed)].filter((item) => item !== label);
  return collapsed.includes(label) ? rest : [...rest, label];
}

/** What the Admin block of the sidebar holds. Each page already refuses anyone who is not an administrator. */
export const ADMIN_ENTRIES: { label: string; href: string; icon: IconName }[] = [
  { label: "Apps", href: "/apps", icon: "apps" },
  { label: "Groups", href: "/groups", icon: "folder" },
  { label: "Status", href: "/status", icon: "chart" },
  { label: "Settings", href: "/settings", icon: "settings" },
];

/** The current page is inside the Admin block, so the block opens by itself. */
export function isAdminPath(pathname: string): boolean {
  return ADMIN_ENTRIES.some((item) => isActive(pathname, item.href));
}

/** The icons a manifest may name. Anything else gets the generic one, so a typo never breaks the sidebar. */
export const ICON_NAMES = ["app", "home", "apps", "settings", "dashboard", "documents", "chart", "megaphone", "users", "database", "mail", "calendar", "folder", "shield", "bolt"] as const;
export type IconName = (typeof ICON_NAMES)[number];

export function resolveIcon(name: string | undefined): IconName {
  return name !== undefined && (ICON_NAMES as readonly string[]).includes(name) ? (name as IconName) : "app";
}
