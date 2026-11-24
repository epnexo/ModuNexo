import { SWITCH_GRACE_MS, readLiveDist, removeStrayDists, distRecordPath } from "./dist.ts";
import { readJournal } from "./journal.ts";

export interface ServerStart {
  /** The build directory the server about to start must serve; it goes to the process as `MODUNEXO_DIST_DIR`. */
  dist: string;
  /** Why the record of the live directory was not followed, when it was not. */
  warning: string | null;
  /** The directories and tsconfig files that were cleared because nothing serves them. */
  removed: string[];
}

/**
 * What to do before the web server is started, the first time and after every restart: choose the build to serve (the
 * record's, else `.next`) and clear the build directories nobody serves. A directory a run is building right now is named by
 * its journal and left alone, so a restart in the middle of an install does not pull the build from under it; and nothing is
 * cleared in the minute after a switch, in case the server it replaced is still draining.
 */
export function prepareServerStart(webRoot: string, dataDir: string): ServerStart {
  const live = readLiveDist(webRoot, dataDir);
  const building = readJournal(dataDir)?.dist;
  const removed = removeStrayDists(webRoot, building === undefined ? [live.name] : [live.name, building], { recordPath: distRecordPath(dataDir) });
  return { dist: live.name, warning: live.reason === null ? null : `${live.reason}; serving ${live.name} instead`, removed };
}

/** A margin after the grace, so the cleanup never fires on the very instant the grace ends. */
const CLEANUP_MARGIN_MS = 5_000;

export interface CleanupOptions {
  /** The grace a switch protects the build it replaced for; defaults to the one `removeStrayDists` uses. */
  graceMs?: number;
  /** Called with what was removed, when something was. */
  onRemoved?: (removed: string[]) => void;
  /** Injectable for tests; the real ones by default. The timer is never allowed to keep the process alive. */
  setTimer?: (fn: () => void, ms: number) => { unref?: () => unknown } | unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Clears the builds nobody serves once the grace of a switch is over. `prepareServerStart` clears them when the server starts, but
 * that is the moment of the switch itself, when the build that was replaced is protected for a minute because the server it replaced
 * may still be draining; so an upgrade left its predecessor on disk (about 190 MB) until the next restart or build. This runs once,
 * after that minute, and asks the same question again with what is true then: the build named by the record is kept, and so is any
 * build a run is making right now (its journal names it). A switch in the meantime starts a new grace and removes nothing; the restart
 * that comes with it schedules the next one, so the supervisor cancels the pending one first.
 */
export function scheduleStrayCleanup(webRoot: string, dataDir: string, options: CleanupOptions = {}): { cancel: () => void } {
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as NodeJS.Timeout));
  const grace = options.graceMs ?? SWITCH_GRACE_MS;
  const handle = setTimer(() => {
    const live = readLiveDist(webRoot, dataDir);
    const building = readJournal(dataDir)?.dist;
    const removed = removeStrayDists(webRoot, building === undefined ? [live.name] : [live.name, building], { recordPath: distRecordPath(dataDir), graceMs: grace });
    if (removed.length > 0) options.onRemoved?.(removed);
  }, grace + CLEANUP_MARGIN_MS);
  (handle as { unref?: () => unknown })?.unref?.();
  let cancelled = false;
  return {
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      clearTimer(handle);
    },
  };
}
