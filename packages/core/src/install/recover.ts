import { existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type pg from "pg";
import { generateRegistration } from "../codegen/generate.ts";
import { registrationModulesFor } from "../codegen/enabled.ts";
import { discoverModules } from "../discovery.ts";
import { LifecycleService } from "../lifecycle/index.ts";
import { closeStaleOperations, liveOperation } from "../operations/index.ts";
import { Registry } from "../registry.ts";
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
    if (keep) {
      rmSync(backup, { recursive: true, force: true });
      notes.push(`recovered: ${subject} was interrupted after its database step had completed, so its result was kept (restart the server to serve it)`);
    } else {
      if (current !== null && !isChange(current)) undoPlacement(current);
      if (existsSync(backup)) {
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
