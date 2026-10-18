import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type ModuleManifest, SDK_VERSION } from "@modunexo/sdk";
import { CORE_VERSION } from "./version.ts";

export const CORE_MODULE_ID = "core";

/**
 * The directory of this package; the core manifest's relative `migrationsDir` resolves against it. Built from the
 * file's own path and not from `new URL(".", import.meta.url)`: a bundler reads that form as a static asset and
 * fails when this module ends up inside the web app's bundle.
 */
export const CORE_MODULE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
