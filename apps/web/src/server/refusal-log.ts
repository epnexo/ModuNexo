export type RefusalLog = (reason: string, line: string) => void;

/**
 * Logs why the gate refused a request, at most once per reason per window, so someone hammering the server
 * cannot fill the log. The next line after a quiet window says how many were left out.
 */
export function createRefusalLog(write: (line: string) => void, now: () => number = Date.now, windowMs = 60_000): RefusalLog {
  const state = new Map<string, { at: number; skipped: number }>();
  return (reason, line) => {
    const current = state.get(reason);
    const t = now();
    if (current === undefined || t - current.at >= windowMs) {
      write(current !== undefined && current.skipped > 0 ? `${line} (${current.skipped} similar refusals in the last minute were not logged)` : line);
      state.set(reason, { at: t, skipped: 0 });
    } else {
      current.skipped += 1;
    }
  };
}
