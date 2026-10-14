import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { launchApply } from "@epnexo/core/install";
import { liveOperation, listOperations } from "@epnexo/core/operations";
import { ARCHIVE_LIMITS, buildPackageContext, listIntakes, receiveUpload, stagingPath } from "@epnexo/core/packages";
import { type AppsDeps, plainActor } from "./apps-api.ts";
import { platform } from "./platform.ts";
import { resolveViewer } from "./viewer.ts";

/**
 * Where the repository is: the launcher and `next dev` both run with `apps/web` as the working directory. Resolved
 * from there, and checked, rather than from this file's location, which a bundler is free to move.
 */
function repoRoot(): string {
  const root = resolve(process.cwd(), "../..");
  if (!existsSync(join(root, "packages", "core", "src", "cli", "index.ts"))) {
    throw new Error(`cannot find the repository root from ${process.cwd()}: the Apps screen needs the CLI it starts`);
  }
  return root;
}

const dataDir = (root: string): string => (process.env.EPNEXO_DATA_DIR ? resolve(process.env.EPNEXO_DATA_DIR) : join(root, "var"));

const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : value);

/** The real dependencies of the Apps API: this process's database, the repository and the `apply` command. */
export function appsDeps(): AppsDeps {
  return {
    viewer: (headers) => resolveViewer(headers),
    maxUploadBytes: ARCHIVE_LIMITS.archiveBytes,
    receive: async (body, options) => {
      const root = repoRoot();
      const { pool } = platform();
      const context = await buildPackageContext({ modulesDir: join(root, "modules"), repoRoot: root, pool });
      return receiveUpload({ pool, body, dataDir: dataDir(root), context, actor: options.actor, ...(options.expectedSha256 === undefined ? {} : { expectedSha256: options.expectedSha256 }) });
    },
    isStaged: async (sha256) => {
      const root = repoRoot();
      const rows = await listIntakes(platform().pool, { sha256, limit: 20 });
      return rows.some((row) => row.status === "staged") && existsSync(stagingPath(dataDir(root), sha256));
    },
    launch: async (sha256, actor) => {
      const root = repoRoot();
      return launchApply({
        pool: platform().pool,
        sha256,
        actor: plainActor(actor),
        dataDir: dataDir(root),
        entry: ["--import", "tsx", join(root, "packages", "core", "src", "cli", "index.ts")],
        cwd: root,
      });
    },
    state: async () => {
      const { pool } = platform();
      const [operations, packages, running] = await Promise.all([listOperations(pool, { limit: 20 }), listIntakes(pool, { limit: 30 }), liveOperation(pool)]);
      const dates = (row: object): Record<string, unknown> => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, iso(value)]));
      return { operations: operations.map(dates), packages: packages.map(dates), running: running === undefined ? null : dates(running) };
    },
  };
}
