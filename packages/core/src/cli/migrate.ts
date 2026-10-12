// Thin wrapper behind `npm run db:migrate`; the full CLI arrives with the lifecycle.
import { discoverModules, MODULES_DIR } from "../discovery.ts";
import { createPool, resolveDatabaseUrl } from "../pool.ts";
import { Registry } from "../registry.ts";
import { migrate } from "../runner.ts";

async function main(): Promise<void> {
  const url = resolveDatabaseUrl();

  const registry = new Registry();
  registry.registerCore();
  for (const manifest of await discoverModules(MODULES_DIR)) registry.register(manifest);

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
  process.exitCode = 1;
});
