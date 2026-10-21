import { readLiveDist, removeStrayDists, distRecordPath } from "./dist.ts";
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
