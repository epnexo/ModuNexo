import { Registry } from "@epnexo/core/registry";
import { modules } from "../generated/modules.ts";

let cached: Registry | undefined;

/** A registry of the modules this build was generated with, for the services that check a module id or its settings. */
export function webRegistry(): Registry {
  if (cached === undefined) {
    const registry = new Registry();
    registry.registerCore();
    for (const manifest of modules) registry.register(manifest);
    cached = registry;
  }
  return cached;
}
