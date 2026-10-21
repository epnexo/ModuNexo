import { join } from "node:path";
import type { NextConfig } from "next";
import { listModulePackages } from "./src/server/module-packages.ts";
import { headerRules } from "./src/server/security-headers.ts";

const repositoryRoot = join(import.meta.dirname, "../..");

// Every package unpacked under `modules/` ships TypeScript sources, like the platform packages, so the bundler has
// to compile them. A package that is present but not enabled is simply never imported.
const modules = listModulePackages(join(repositoryRoot, "modules"));
for (const warning of modules.warnings) console.warn(`warning: ${warning}`);

// Where `next build` writes and `next start` reads. A module change builds into a directory of its own while the server
// keeps serving the current one; the platform tells each process which one through this variable. The name is checked
// because it becomes a folder inside this one (the same rule as `isDistName` in packages/core/src/install/dist.ts).
const requestedDist = process.env.MODUNEXO_DIST_DIR;
if (requestedDist && !/^\.next(-[a-zA-Z0-9]{1,24})?$/.test(requestedDist)) {
  throw new Error(`MODUNEXO_DIST_DIR must be ".next" or ".next-" and letters and digits, not "${requestedDist}"`);
}
const distDir = requestedDist || ".next";

const config: NextConfig = {
  distDir,
  // The app's tsconfig names `.next/types` by path, so a build into another directory is type-checked with the tsconfig
  // written for it (`writeDistTsconfig`), which names only that directory's types.
  ...(distDir === ".next" ? {} : { typescript: { tsconfigPath: `tsconfig${distDir}.json` } }),
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
