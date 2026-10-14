import { readFileSync } from "node:fs";
import { join } from "node:path";

/** What the web launcher's command line contains; a process without it is not the launcher, whatever its pid. */
export const LAUNCHER_MARKER = "apps/web/scripts/run.ts";

/** Where the launcher records its pid while it runs, so a restart can be asked for from another process. */
export const pidFilePath = (dataDir: string): string => join(dataDir, "run", "web.pid");

export interface RestartOptions {
  dataDir: string;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** The command line of a process (arguments separated by NUL), or null when there is no such process. */
  readCmdline?: (pid: number) => string | null;
}

function procCmdline(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    return null;
  }
}

/**
 * Asks the running web launcher to restart its server (it does so on SIGUSR2) and says what happened. Nothing is
 * signalled unless the recorded pid is a live process whose command line is the launcher's, so a stale file or a
 * recycled pid can never make this signal somebody else.
 */
export async function requestRestart(options: RestartOptions): Promise<string> {
  const kill = options.kill ?? ((pid, signal) => process.kill(pid, signal));
  const readCmdline = options.readCmdline ?? procCmdline;
  let raw: string;
  try {
    raw = readFileSync(pidFilePath(options.dataDir), "utf8").trim();
  } catch {
    return "no web server is running here (no pid file); start it with `npm run web:start` to serve the change";
  }
  if (!/^\d{1,9}$/.test(raw) || Number(raw) <= 1) return `the pid file ${pidFilePath(options.dataDir)} does not hold a process id; nothing was signalled`;
  const pid = Number(raw);
  const cmdline = readCmdline(pid);
  if (cmdline === null) return `the recorded web server (pid ${pid}) is not running (stale pid file); start it with \`npm run web:start\``;
  // The launcher is `... apps/web/scripts/run.ts start`; `build` and `dev` run the same script and must not be signalled.
  const words = cmdline.split("\0").filter((word) => word !== "");
  const at = words.findIndex((word) => word.endsWith(LAUNCHER_MARKER));
  if (at === -1 || words[at + 1] !== "start") return `pid ${pid} is not the web launcher (stale pid file); nothing was signalled`;
  kill(pid, "SIGUSR2");
  return `restart requested from the web launcher (pid ${pid})`;
}
