import { join } from "node:path";
import type { NextConfig } from "next";
import { listModulePackages } from "./src/server/module-packages.ts";

const repositoryRoot = join(import.meta.dirname, "../..");

// Every package unpacked under `modules/` ships TypeScript sources, like the platform packages, so the bundler has
// to compile them. A package that is present but not enabled is simply never imported.
const modules = listModulePackages(join(repositoryRoot, "modules"));
for (const warning of modules.warnings) console.warn(`warning: ${warning}`);

const config: NextConfig = {
  transpilePackages: ["@epnexo/core", "@epnexo/sdk", ...modules.names],
  // The monorepo root, so the workspace packages outside this directory are traced and watched.
  outputFileTracingRoot: repositoryRoot,
  turbopack: { root: repositoryRoot },
  poweredByHeader: false,
};

export default config;
