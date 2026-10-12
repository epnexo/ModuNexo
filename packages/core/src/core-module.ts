import { type ModuleManifest, SDK_VERSION } from "@epnexo/sdk";
import { CORE_VERSION } from "./version.ts";

export const CORE_MODULE_ID = "core";

/** The core is itself a module: it owns the `core` schema, which later holds lifecycle state and migration history. */
export const coreManifest: ModuleManifest = {
  id: CORE_MODULE_ID,
  version: CORE_VERSION,
  name: "Core",
  platform: `^${SDK_VERSION}`,
  dependsOn: {},
  schema: "core",
  migrationsDir: "migrations",
  nav: [],
};
