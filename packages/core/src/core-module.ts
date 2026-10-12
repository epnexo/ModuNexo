import { fileURLToPath } from "node:url";
import { type ModuleManifest, SDK_VERSION } from "@epnexo/sdk";
import { CORE_VERSION } from "./version.ts";

export const CORE_MODULE_ID = "core";

/** The directory of this package; the core manifest's relative `migrationsDir` resolves against it. */
export const CORE_MODULE_DIR = fileURLToPath(new URL("../", import.meta.url));

/** The core is itself a module: it owns the `core` schema, which holds migration history, lifecycle state and the lifecycle audit log. */
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
