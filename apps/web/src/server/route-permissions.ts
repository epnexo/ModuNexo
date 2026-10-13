/** What a module's manifest says about who may reach which path. Only the parts this file reads. */
interface ModuleSource {
  pages?: readonly { path: string; permission?: string }[];
  nav?: readonly { href: string; permission?: string }[];
}

export type PermissionRule =
  | { kind: "route"; segments: string[]; permission: string }
  | { kind: "prefix"; segments: string[]; permission: string };

const segmentsOf = (path: string): string[] => path.split("/").filter((segment) => segment !== "");

/**
 * The permission rules of a registry. A page's own `permission` covers that route, dynamic segments included. A
 * navigation entry's `permission` covers its `href` and everything below it, so a link that is hidden cannot be
 * reached by typing its address. A link that is not a path of this app (an absolute URL, a relative one) is not a
 * rule, because the gate cannot reason about where it goes.
 */
export function permissionRules(modules: readonly ModuleSource[]): PermissionRule[] {
  const rules: PermissionRule[] = [];
  for (const module of modules) {
    for (const page of module.pages ?? []) {
      if (page.permission === undefined || !page.path.startsWith("/")) continue;
      rules.push({ kind: "route", segments: segmentsOf(page.path), permission: page.permission });
    }
    for (const entry of module.nav ?? []) {
      if (entry.permission === undefined) continue;
      const href = entry.href.split(/[?#]/)[0]!;
      if (!href.startsWith("/") || href.startsWith("//")) continue;
      const kept: string[] = [];
      for (const segment of segmentsOf(href)) {
        if (segment.includes("[")) break;
        kept.push(segment);
      }
      if (kept.length > 0) rules.push({ kind: "prefix", segments: kept, permission: entry.permission });
    }
  }
  return rules;
}

/** Does a Next.js route pattern such as `/a/[id]/[...rest]` match these path segments? */
function matchesRoute(pattern: readonly string[], path: readonly string[]): boolean {
  for (let i = 0; i < pattern.length; i++) {
    const segment = pattern[i]!;
    if (segment.startsWith("[[...") && segment.endsWith("]]")) return true;
    if (segment.startsWith("[...") && segment.endsWith("]")) return path.length > i;
    if (path[i] === undefined) return false;
    if (segment.startsWith("[") && segment.endsWith("]")) continue;
    if (segment !== path[i]) return false;
  }
  return path.length === pattern.length;
}

/** Every permission the path needs, without repeats. Empty means the path asks for none. */
export function requiredPermissions(pathname: string, rules: readonly PermissionRule[]): string[] {
  const path = segmentsOf(pathname);
  const needed = new Set<string>();
  for (const rule of rules) {
    const covered =
      rule.kind === "route" ? matchesRoute(rule.segments, path) : path.length >= rule.segments.length && rule.segments.every((segment, i) => segment === path[i]);
    if (covered) needed.add(rule.permission);
  }
  return [...needed];
}
