/** The URL prefixes a module's pages live under, used to tell which module a path belongs to. */
export interface ModuleScope {
  id: string;
  prefixes: string[];
}

interface ScopeSource {
  id: string;
  pages?: readonly { path: string }[];
  nav?: readonly { href: string }[];
}

/** `/a/x/[id]/y` becomes `/a/x`: the part that is the same for every value of a dynamic segment. */
function staticPrefix(path: string): string | null {
  if (!path.startsWith("/") || path.startsWith("//")) return null;
  const kept: string[] = [];
  for (const segment of path.split("/").filter((part) => part !== "")) {
    if (segment.includes("[")) break;
    kept.push(segment);
  }
  return kept.length === 0 ? null : `/${kept.join("/")}`;
}

export function moduleScopes(modules: readonly ScopeSource[]): ModuleScope[] {
  return modules.map((module) => {
    const prefixes: string[] = [];
    for (const raw of [...(module.pages ?? []).map((page) => page.path), ...(module.nav ?? []).map((entry) => entry.href)]) {
      const prefix = staticPrefix(raw);
      if (prefix !== null && !prefixes.includes(prefix)) prefixes.push(prefix);
    }
    return { id: module.id, prefixes };
  });
}

/** The module that owns the path: the longest prefix that is the path or a parent of it, or null for the shell's own. */
export function moduleForPath(pathname: string, scopes: readonly ModuleScope[]): string | null {
  const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  let best: { id: string; length: number } | null = null;
  for (const scope of scopes) {
    for (const prefix of scope.prefixes) {
      if ((path === prefix || path.startsWith(`${prefix}/`)) && (best === null || prefix.length > best.length)) best = { id: scope.id, length: prefix.length };
    }
  }
  return best === null ? null : best.id;
}
