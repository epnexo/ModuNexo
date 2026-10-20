/** What a module's manifest says about who may reach which path. Only the parts this file reads. */
interface ModuleSource {
  pages?: readonly { path: string; permission?: string; public?: unknown; scope?: unknown }[];
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

const decodeOnce = (text: string): string => {
  try {
    return decodeURIComponent(text);
  } catch {
    // A malformed escape: what cannot be decoded is kept as it is.
    return text;
  }
};

/**
 * Every way the router could read this path: as written, with each segment decoded once and with each decoded as
 * far as it goes (a double encoding), splitting again where a decoded segment holds a slash. The gate sees the path
 * as it arrived while the router decodes before it resolves a route, so a rule is applied to all of them and the
 * permissions are added up: the strictest reading wins, and no reading is left to chance.
 */
function pathReadings(pathname: string): string[][] {
  const raw = segmentsOf(pathname);
  const readings: string[][] = [raw];
  let current = raw;
  for (let round = 0; round < 4; round++) {
    const next = current.flatMap((segment) => segmentsOf(decodeOnce(segment)));
    if (next.length === current.length && next.every((segment, i) => segment === current[i])) break;
    readings.push(next);
    current = next;
  }
  return readings;
}

/** Every permission the path needs, without repeats. Empty means the path asks for none. */
export function requiredPermissions(pathname: string, rules: readonly PermissionRule[]): string[] {
  const needed = new Set<string>();
  for (const path of pathReadings(pathname)) {
    for (const rule of rules) {
      const covered =
        rule.kind === "route" ? matchesRoute(rule.segments, path) : path.length >= rule.segments.length && rule.segments.every((segment, i) => segment === path[i]);
      if (covered) needed.add(rule.permission);
    }
  }
  return [...needed];
}

/** The shell-owned prefixes of routes that answer without a session and verify their caller themselves. */
const SIGNED_PREFIX = "hooks";
const TOKEN_PREFIX = "svc";

/**
 * The routes that answer without a session: the pages that declare themselves `public` (signed, under `/hooks`) and
 * the pages that declare a `scope` (service token, under `/svc`). The prefix is checked again here so that a
 * manifest that slipped past validation still cannot open an ordinary path, and a page that declares both is
 * ignored rather than guessed at.
 */
export function publicRouteRules(modules: readonly ModuleSource[]): string[][] {
  const rules: string[][] = [];
  for (const module of modules) {
    for (const page of module.pages ?? []) {
      if (!page.path.startsWith("/") || (page.public === undefined) === (page.scope === undefined)) continue;
      const segments = segmentsOf(page.path);
      if (segments[0] === (page.public !== undefined ? SIGNED_PREFIX : TOKEN_PREFIX) && segments.length > 1) rules.push(segments);
    }
  }
  return rules;
}

/**
 * Is this path a declared public route? Every reading of the path (see `pathReadings`) has to land on one, so an
 * encoding that the router would read as another path, a dot segment included, never counts as public. When in
 * doubt the answer is no, and the request meets the ordinary gate.
 */
export function isPublicRoute(pathname: string, rules: readonly (readonly string[])[]): boolean {
  if (rules.length === 0) return false;
  return pathReadings(pathname).every(
    (path) => path.length > 0 && path.every((segment) => segment !== "." && segment !== "..") && rules.some((rule) => matchesRoute(rule, path)),
  );
}
