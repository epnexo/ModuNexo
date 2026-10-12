import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface ModulePackages {
  names: string[];
  /** One line per package that was skipped, naming its directory. */
  warnings: string[];
}

/**
 * The package names of everything unpacked under `modules/`. The bundler has to compile each one, and reading the
 * directory keeps the web config free of module names. A package that is half unpacked, unreadable or nameless is
 * skipped with a warning that names its directory: one broken download must not stop the whole shell from loading.
 */
export function listModulePackages(modulesDir: string): ModulePackages {
  const result: ModulePackages = { names: [], warnings: [] };
  if (!existsSync(modulesDir)) return result;
  for (const entry of readdirSync(modulesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = join(modulesDir, entry.name, "package.json");
    if (!existsSync(manifest)) continue;
    try {
      const name: unknown = JSON.parse(readFileSync(manifest, "utf8")).name;
      if (typeof name === "string" && name !== "") result.names.push(name);
      else result.warnings.push(`modules/${entry.name}/package.json has no package name; skipped`);
    } catch (error) {
      result.warnings.push(`modules/${entry.name}/package.json cannot be read (${error instanceof Error ? error.message : String(error)}); skipped`);
    }
  }
  result.names.sort();
  return result;
}
