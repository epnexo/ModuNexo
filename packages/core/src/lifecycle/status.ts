import type { ModuleManifest } from "@modunexo/sdk";
import { gt } from "semver";
import { type InstalledModule, type ModuleStatusKind, isValidInstalledVersion } from "./transitions.ts";

/** What a listing shows for one module. */
export interface ModuleStatus {
  id: string;
  status: ModuleStatusKind;
  /** Version of the package on disk; absent for an orphan. */
  packageVersion?: string;
  /** Version recorded at install or upgrade; absent for an available module. */
  installedVersion?: string;
  /** The package on disk is newer than the installed version. */
  upgradePending: boolean;
  /** `core.modules` has a row but there is no package on disk. */
  orphaned: boolean;
  /** Available again after an uninstall with `keep`: the module's schema still exists. */
  dataRetained: boolean;
  /** The version stored in `core.modules` is not valid semver. The row is listed, but every action on it is refused. */
  invalidInstalledVersion: boolean;
}

export interface StatusInput {
  id: string;
  /** The package on disk, when there is one. */
  manifest?: ModuleManifest | undefined;
  /** The row in `core.modules`, when there is one. */
  installed?: InstalledModule | undefined;
  /** Whether the module's schema exists in the database. This is the one fact that needs the database. */
  schemaExists: boolean;
}

export function deriveStatus({ id, manifest, installed, schemaExists }: StatusInput): ModuleStatus {
  const invalid = installed !== undefined && !isValidInstalledVersion(installed.installedVersion);
  const status: ModuleStatus = {
    id,
    status: installed?.state ?? "available",
    upgradePending: manifest !== undefined && installed !== undefined && !invalid && gt(manifest.version, installed.installedVersion),
    orphaned: installed !== undefined && manifest === undefined,
    dataRetained: installed === undefined && manifest !== undefined && schemaExists,
    invalidInstalledVersion: invalid,
  };
  if (manifest !== undefined) status.packageVersion = manifest.version;
  if (installed !== undefined) status.installedVersion = installed.installedVersion;
  return status;
}
