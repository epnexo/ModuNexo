import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SDK_VERSION } from "@epnexo/sdk";
import type pg from "pg";
import type { PackageContext } from "./validate.ts";

/** The repository the platform runs from: its own `node_modules` is the only place a module's libraries may come from. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

const SAFE_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

function readVersion(file: string): string | null {
  try {
    if (!lstatSync(file).isFile()) return null;
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    const version = typeof raw === "object" && raw !== null ? (raw as { version?: unknown }).version : undefined;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

/** The version installed under `<repoRoot>/node_modules/<name>`. A name that is not a plain package name is never looked up. */
export function installedVersionIn(repoRoot: string): (name: string) => string | null {
  return (name) => (SAFE_PACKAGE_NAME.test(name) && name.length <= 214 ? readVersion(join(repoRoot, "node_modules", name, "package.json")) : null);
}

/** The npm name each unpacked module package carries, by module folder (which is the module id). */
function packageNames(modulesDir: string): Map<string, string> {
  const names = new Map<string, string>();
  if (!existsSync(modulesDir)) return names;
  for (const entry of readdirSync(modulesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const raw: unknown = JSON.parse(readFileSync(join(modulesDir, entry.name, "package.json"), "utf8"));
      const name = typeof raw === "object" && raw !== null ? (raw as { name?: unknown }).name : undefined;
      if (typeof name === "string") names.set(entry.name, name);
    } catch {
      // A folder without a readable package.json simply has no package name to collide with.
    }
  }
  return names;
}

export interface PackageContextOptions {
  repoRoot?: string;
  modulesDir: string;
  /** When given, the modules the platform has installed are read from it; without it none are known. */
  pool?: pg.Pool;
}

/** What a package is checked against: this platform's SDK, its installed libraries and the modules it already has. */
export async function buildPackageContext(options: PackageContextOptions): Promise<PackageContext> {
  const modules = new Map<string, string>();
  if (options.pool !== undefined) {
    const present = await options.pool.query("select to_regclass('core.modules') is not null as present");
    if (present.rows[0].present) {
      const { rows } = await options.pool.query("select id, installed_version from core.modules");
      for (const row of rows) modules.set(row.id, row.installed_version);
    }
  }
  return {
    sdkVersion: SDK_VERSION,
    installedVersion: installedVersionIn(options.repoRoot ?? REPO_ROOT),
    modules,
    modulePackages: packageNames(options.modulesDir),
  };
}
