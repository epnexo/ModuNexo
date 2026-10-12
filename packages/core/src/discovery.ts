import { type Dirent, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type ModuleManifest, ManifestError, validateManifest } from "@epnexo/sdk";
import { compareIds } from "./registry.ts";

/** The repository's `modules/` directory, where installed module packages are unpacked. */
export const MODULES_DIR = fileURLToPath(new URL("../../../modules", import.meta.url));

/**
 * Load `<modulesDir>/<folder>/manifest.ts` for every module folder, sorted by folder name.
 * Each manifest must default-export its manifest and use the folder name as its id.
 * Relative `migrationsDir` values are resolved against the module folder.
 */
export async function discoverModules(modulesDir: string): Promise<ModuleManifest[]> {
  if (!existsSync(modulesDir)) return [];

  const isModuleFolder = (entry: Dirent): boolean => {
    // A module folder may be a symlink to a package checked out elsewhere.
    const isDirectory = entry.isDirectory() || (entry.isSymbolicLink() && statSync(join(modulesDir, entry.name)).isDirectory());
    return isDirectory && existsSync(join(modulesDir, entry.name, "manifest.ts"));
  };
  const folders = readdirSync(modulesDir, { withFileTypes: true })
    .filter(isModuleFolder)
    .map((entry) => entry.name)
    .sort(compareIds);

  const manifests: ModuleManifest[] = [];
  for (const folder of folders) {
    const file = join(modulesDir, folder, "manifest.ts");
    const loaded: { default?: unknown } = await import(pathToFileURL(file).href);
    if (loaded.default === undefined) throw new Error(`${file} must have a default export with the module manifest`);

    let manifest: ModuleManifest;
    try {
      manifest = validateManifest(loaded.default);
    } catch (error) {
      if (error instanceof ManifestError) throw new Error(`${file}: ${error.message}`);
      throw error;
    }
    if (manifest.id !== folder) throw new Error(`folder "${folder}" declares id "${manifest.id}"; the folder name must match the module id`);

    manifests.push({ ...manifest, migrationsDir: resolve(modulesDir, folder, manifest.migrationsDir) });
  }
  return manifests;
}
