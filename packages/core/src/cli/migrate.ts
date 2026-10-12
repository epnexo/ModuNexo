// Thin wrapper behind `npm run db:migrate`; the full CLI arrives with the lifecycle.
import { parseArgs } from "node:util";
import { discoverModules, resolveModulesDir } from "../discovery.ts";
import { createPool, resolveDatabaseUrl } from "../pool.ts";
import { Registry } from "../registry.ts";
import { MigrationRunError, migrate } from "../runner.ts";

async function main(): Promise<void> {
  // The modules directory is an argument, not an environment variable: the environment is for infrastructure only.
  const { values } = parseArgs({ options: { "modules-dir": { type: "string" } }, allowPositionals: false });
  const modulesDir = resolveModulesDir(values["modules-dir"]);
  const url = resolveDatabaseUrl();

  const registry = new Registry();
  registry.registerCore();
  const { modules, warnings } = await discoverModules(modulesDir);
  for (const warning of warnings) console.error(`warning: ${warning}`);
  for (const manifest of modules) registry.register(manifest);

  const pool = createPool(url, { connectionTimeoutMillis: 5000 });
  try {
    const { applied } = await migrate(pool, registry);
    if (applied.length === 0) {
      console.log("nothing to apply");
    } else {
      for (const { moduleId, filename } of applied) console.log(`applied ${moduleId}/${filename}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  if (error instanceof MigrationRunError && error.applied.length > 0) {
    // Those files are committed and stay applied; say so, so a failed deploy is not mistaken for a clean rollback.
    console.error("applied before the failure:");
    for (const { moduleId, filename } of error.applied) console.error(`  ${moduleId}/${filename}`);
  }
  process.exitCode = 1;
});
