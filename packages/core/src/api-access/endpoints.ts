import type { ModuleManifest } from "@modunexo/sdk";

export interface ServiceEndpoint {
  method: string;
  /** The path as the manifest declares it; a dynamic segment such as `[id]` is kept as written. */
  path: string;
  scope: string;
  scopeLabel: string;
}

/**
 * The calls a service token can make to a module: its routes that name a scope. A page, or a route that asks for a
 * signed-in user's permission instead, is not part of the module's API. Ordered by path, then method.
 */
export function serviceEndpoints(manifest: Pick<ModuleManifest, "pages" | "scopes">): ServiceEndpoint[] {
  const labels = new Map((manifest.scopes ?? []).map((scope) => [scope.key, scope.label]));
  const endpoints: ServiceEndpoint[] = [];
  for (const page of manifest.pages ?? []) {
    if (page.kind !== "route" || page.scope === undefined) continue;
    for (const method of page.methods ?? ["GET"]) {
      endpoints.push({ method, path: page.path, scope: page.scope, scopeLabel: labels.get(page.scope) ?? page.scope });
    }
  }
  return endpoints.sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)));
}
