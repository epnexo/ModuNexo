import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { NextConfig } from "next";

const repositoryRoot = join(import.meta.dirname, "../..");

/**
 * Every package unpacked under `modules/` ships TypeScript sources, like the platform packages, so the bundler has
 * to compile them. Reading the directory keeps this file free of module names; a package that is present but not
 * enabled is simply never imported.
 */
function modulePackageNames(): string[] {
  const modulesDir = join(repositoryRoot, "modules");
  if (!existsSync(modulesDir)) return [];
  return readdirSync(modulesDir, { withFileTypes: true }).flatMap((entry) => {
    const manifest = join(modulesDir, entry.name, "package.json");
    if (!existsSync(manifest)) return [];
    const name: unknown = JSON.parse(readFileSync(manifest, "utf8")).name;
    return typeof name === "string" ? [name] : [];
  });
}

const config: NextConfig = {
  transpilePackages: ["@epnexo/core", "@epnexo/sdk", ...modulePackageNames()],
  // The monorepo root, so the workspace packages outside this directory are traced and watched.
  outputFileTracingRoot: repositoryRoot,
  turbopack: { root: repositoryRoot },
  poweredByHeader: false,
};

export default config;
