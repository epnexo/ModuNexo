import { ApiAddressService } from "@modunexo/core/api-access";
import { TokenService } from "@modunexo/core/tokens";
import type { ApiAccessDeps } from "./module-tokens-api.ts";
import { platform } from "./platform.ts";
import { enabledModuleIds, webRegistry } from "./registry.ts";
import { resolveViewer } from "./viewer.ts";

/** The real dependencies of the API access routes: this process's database, registry and the signed-in viewer. */
export function apiAccessDeps(): ApiAccessDeps {
  const pool = platform().pool;
  const tokens = new TokenService(pool, webRegistry());
  const address = new ApiAddressService(pool);
  return {
    viewer: (headers) => resolveViewer(headers),
    now: () => new Date(),
    service: {
      moduleIsEnabled: async (id) => id !== "core" && webRegistry().get(id) !== undefined && (await enabledModuleIds(pool)).has(id),
      list: (id) => tokens.list(id),
      find: (id) => tokens.find(id),
      create: (input) => tokens.create(input),
      regenerate: (id, actor) => tokens.regenerate(id, actor),
      revoke: (id, actor) => tokens.revoke(id, actor),
      setAddress: (raw, actor) => address.set(raw, actor),
      unsetAddress: (actor) => address.unset(actor),
    },
  };
}
