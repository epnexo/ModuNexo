import { existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import { generateRegistration } from "../codegen/generate.ts";
import { registrationModulesFor } from "../codegen/enabled.ts";
import { discoverModules } from "../discovery.ts";
import { LifecycleService } from "../lifecycle/index.ts";
import { closeStaleOperations, liveOperation } from "../operations/index.ts";
import { Registry } from "../registry.ts";
import { distTsconfigName, readLiveDist, writeLiveDist } from "./dist.ts";
import { clearJournal, isChange, readJournal } from "./journal.ts";
import { undoPlacement } from "./place.ts";

/** The registry of what is on disk, as the CLI builds it. `fresh` re-reads packages replaced during this process. */
export async function registryFromDisk(modulesDir: string, fresh = false): Promise<Registry> {
  const registry = new Registry({ allowUnsupportedPlatform: true });
  registry.registerCore();
  const { modules } = await discoverModules(modulesDir, { freshImport: fresh });
  for (const manifest of modules) registry.register(manifest);
  return registry;
}

export interface RecoverOptions {
  pool: pg.Pool;
  dataDir: string;
  modulesDir: string;
  webRoot: string;
}

/**
 * Finishes what a run that was killed (or lost its machine) left behind, before anything new starts: its journal
 * says what it was changing, and without one nothing is touched. If its database step had completed the result is kept; otherwise the files, the
 * link, the build and the registration are put back. Does nothing while a run is alive. Returns what it did.
 */
export async function recoverInterrupted(options: RecoverOptions): Promise<string[]> {
  const journal = readJournal(options.dataDir);
  const backup = join(options.webRoot, ".next.rollback");
  // The journal is the only evidence of an interrupted run. A kept build on its own proves nothing: it is also what
  // a run that is building right now leaves, possibly one recorded in another database (a test, a second checkout
  // sharing the web folder), which this process cannot see as alive. Restoring it would delete that build.
  if (journal === null) return [];

  const lock = await options.pool.connect();
  try {
    await lock.query("select pg_advisory_lock(hashtextextended('epnexo.apply.recover', 0))");
    await closeStaleOperations(options.pool);
    if ((await liveOperation(options.pool)) !== undefined) return [];
    const current = readJournal(options.dataDir);
    if (current === null) return [];

    const notes: string[] = [];
    const subject = current === null ? "a run" : isChange(current) ? `the ${current.action} of ${current.moduleId}` : `the ${current.kind} of ${current.moduleId} ${current.version}`;
    let keep = false;
    if (current !== null && current.phase === "lifecycle") {
      const { rows } = await options.pool.query("select state, installed_version from core.modules where id = $1", [current.moduleId]);
      if (isChange(current)) {
        const found = rows[0] === undefined ? "gone" : rows[0].state;
        keep = found === current.expected;
      } else keep = rows[0]?.installed_version === current.version;
    }
    // A journal that names the build that is serving (a forged or damaged one: a run never names it) must not take it away.
    const serving = readLiveDist(options.webRoot, options.dataDir).name;
    const dist = current.dist === serving ? undefined : current.dist;
    if (current.dist !== undefined && dist === undefined) notes.push(`the journal named ${serving}, which is the build that is serving, so it was left alone`);
    if (keep) {
      if (dist === undefined) {
        // A journal from before builds had directories of their own: the kept previous build is no longer needed.
        rmSync(backup, { recursive: true, force: true });
        notes.push(`recovered: ${subject} was interrupted after its database step had completed, so its result was kept (restart the server to serve it)`);
      } else if (existsSync(join(options.webRoot, dist, "BUILD_ID"))) {
        // The step the dead run did not get to: the build it made is put in service.
        writeLiveDist(options.dataDir, dist);
        notes.push(`recovered: ${subject} was interrupted after its database step had completed, so its result was kept and its build (${dist}) was put in service (restart the server to serve it)`);
      } else {
        rmSync(join(options.webRoot, dist), { recursive: true, force: true });
        rmSync(join(options.webRoot, distTsconfigName(dist)), { force: true });
        notes.push(`recovered: ${subject} was interrupted after its database step had completed, so its result was kept, but ${dist} is not a finished build, so the build that was serving stays; rebuild with "npm run web:build" to serve the change`);
      }
    } else {
      if (current !== null && !isChange(current)) undoPlacement(current);
      if (dist !== undefined) {
        // The run built beside the build that was serving, which was never touched: only the new directory goes.
        rmSync(join(options.webRoot, dist), { recursive: true, force: true });
        rmSync(join(options.webRoot, distTsconfigName(dist)), { force: true });
      } else if (existsSync(backup)) {
        rmSync(join(options.webRoot, ".next"), { recursive: true, force: true });
        renameSync(backup, join(options.webRoot, ".next"));
      }
      try {
        const registry = await registryFromDisk(options.modulesDir);
        const statuses = await new LifecycleService(options.pool, registry).list();
        generateRegistration(registrationModulesFor(statuses, registry, options.modulesDir).modules, { outDir: options.webRoot });
      } catch (error) {
        notes.push(`recovered files, but the registration could not be regenerated: ${error instanceof Error ? error.message : String(error)}`);
      }
      notes.push(`recovered: ${subject} was interrupted; its files, link, build and registration were put back`);
    }
    clearJournal(options.dataDir);
    return notes;
  } finally {
    try {
      await lock.query("select pg_advisory_unlock_all()");
      lock.release();
    } catch (error) {
      lock.release(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
