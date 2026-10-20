const WINDOW_MS = 60_000;
/** Above this many tracked keys the expired windows are swept, so a flood of addresses cannot grow the map. */
const SWEEP_ABOVE = 1000;

/**
 * A fixed one-minute window per key, held in this process's memory: with several instances each keeps its own
 * count. `hit` counts the request and returns 0 when it may go on, else the seconds the caller should wait.
 */
export function createRateLimiter(now: () => number) {
  const windows = new Map<string, { start: number; count: number }>();
  return {
    hit(key: string, limit: number): number {
      const at = now();
      if (windows.size > SWEEP_ABOVE) {
        for (const [k, w] of windows) if (at - w.start >= WINDOW_MS) windows.delete(k);
      }
      let w = windows.get(key);
      if (w === undefined || at - w.start >= WINDOW_MS) {
        w = { start: at, count: 0 };
        windows.set(key, w);
      }
      w.count += 1;
      if (w.count <= limit) return 0;
      return Math.max(1, Math.ceil((w.start + WINDOW_MS - at) / 1000));
    },
    size: () => windows.size,
  };
}
