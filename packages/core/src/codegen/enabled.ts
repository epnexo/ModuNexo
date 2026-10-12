import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModuleStatus } from "../lifecycle/status.ts";
import type { Registry } from "../registry.ts";
import { RegistrationError, type RegistrationModule } from "./render.ts";

/**
 * The `name` in `<modulesDir>/<moduleId>/package.json`: the package the web app imports the module through.
 * Each failure says which module and what to fix.
 */
export function readPackageName(modulesDir: string, moduleId: string): string {
  const file = join(modulesDir, moduleId, "package.json");
  if (!existsSync(file)) throw new Error(`module "${moduleId}" has no package.json (${file}); the web app imports the module through its package name`);
  let parsed: { name?: unknown };
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`package.json of module "${moduleId}" is not valid JSON (${file})`);
  }
  if (typeof parsed?.name !== "string" || parsed.name.trim() === "") throw new Error(`package.json of module "${moduleId}" has no "name" (${file})`);
  return parsed.name;
}

/**
 * Turn the lifecycle's listing into the modules to register: the enabled ones, each with the manifest the
 * registry holds (the package on disk, which is what gets built) and its package name. An enabled row with no
 * package is skipped with a warning, and a pending upgrade is warned about because the package on disk, not
 * the installed version, is what the web app will contain.
 */
export function registrationModulesFor(statuses: ModuleStatus[], registry: Registry, modulesDir: string): { modules: RegistrationModule[]; warnings: string[] } {
  const modules: RegistrationModule[] = [];
  const warnings: string[] = [];
  const problems: string[] = [];
  for (const status of statuses.filter((s) => s.status === "enabled")) {
    const manifest = registry.get(status.id);
    if (status.orphaned || manifest === undefined) {
      warnings.push(`module "${status.id}" is enabled but its package is not on disk; not registered`);
      continue;
    }
    if (status.upgradePending) {
      warnings.push(`module "${status.id}" has an upgrade pending (package ${status.packageVersion}, installed ${status.installedVersion}); registering the package on disk`);
    }
    try {
      modules.push({ manifest, packageName: readPackageName(modulesDir, status.id) });
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (problems.length > 0) throw new RegistrationError(problems);
  return { modules, warnings };
}
