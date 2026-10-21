import { join } from "node:path";
import type { NextConfig } from "next";
import { listModulePackages } from "./src/server/module-packages.ts";
import { headerRules } from "./src/server/security-headers.ts";

const repositoryRoot = join(import.meta.dirname, "../..");

// Every package unpacked under `modules/` ships TypeScript sources, like the platform packages, so the bundler has
// to compile them. A package that is present but not enabled is simply never imported.
const modules = listModulePackages(join(repositoryRoot, "modules"));
for (const warning of modules.warnings) console.warn(`warning: ${warning}`);

const config: NextConfig = {
  transpilePackages: ["@modunexo/core", "@modunexo/sdk", ...modules.names],
  // The monorepo root, so the workspace packages outside this directory are traced and watched.
  outputFileTracingRoot: repositoryRoot,
  turbopack: { root: repositoryRoot },
  poweredByHeader: false,
  // The shell serves no images through the optimizer, and its endpoint sits outside the access gate.
  images: { unoptimized: true },
  async headers() {
    return headerRules(process.env.WEB_PUBLIC_URL?.trim().startsWith("https://") === true);
  },
};

export default config;
