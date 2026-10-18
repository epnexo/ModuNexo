// Writes an empty module registry when none exists, so a fresh checkout can be typechecked and run in development
// without a database. `npm run web:build` writes the real one from the modules enabled in the database.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { REGISTRY_FILE, generateRegistration } from "@modunexo/core";

export const WEB_ROOT = fileURLToPath(new URL("../", import.meta.url));

/** Returns true when it had to write the empty registry. */
export function ensureRegistry(webRoot: string = WEB_ROOT): boolean {
  if (existsSync(join(webRoot, REGISTRY_FILE))) return false;
  generateRegistration([], { outDir: webRoot });
  return true;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) ensureRegistry();
