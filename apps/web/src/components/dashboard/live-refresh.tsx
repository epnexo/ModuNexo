"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, useTransition } from "react";
import { AUTO_REFRESH_MS, shouldAutoRefresh, updatedLabel } from "../../server/dashboard-live";

const KEY = "modunexo.dashboard.auto";

/**
 * Refresh now, or keep refreshing every 30 s while the tab is visible. A refresh re-renders the page on the server, so it
 * shows only what this person may see; nothing here reads data on its own.
 */
export function LiveRefresh() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [auto, setAuto] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [now, setNow] = useState<Date | null>(null);

  const refresh = useCallback(() => {
    start(() => router.refresh());
    setUpdatedAt(new Date());
  }, [router]);

  // The first render matches the server (no clock, switch off); the real values come after it.
  useEffect(() => {
    setUpdatedAt(new Date());
    setNow(new Date());
    try {
      setAuto(localStorage.getItem(KEY) === "1");
    } catch {
      // A remembered choice is only a convenience.
    }
  }, []);

  useEffect(() => {
    const tick = setInterval(() => setNow(new Date()), 5_000);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    if (!auto) return;
    const run = () => {
      if (shouldAutoRefresh(true, document.visibilityState)) refresh();
    };
    const timer = setInterval(run, AUTO_REFRESH_MS);
    // Coming back to the tab after a while: catch up at once instead of waiting for the next tick.
    document.addEventListener("visibilitychange", run);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", run);
    };
  }, [auto, refresh]);

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
      <button
        type="button"
        onClick={refresh}
        disabled={pending}
        className="inline-flex h-9 items-center gap-2 rounded-md border border-border-strong bg-surface px-3 font-medium transition-colors duration-150 hover:bg-panel-hover disabled:opacity-60"
      >
        <RefreshCw aria-hidden className={`size-4 ${pending ? "motion-safe:animate-spin" : ""}`} />
        Refresh
      </button>
      <label className="inline-flex cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          checked={auto}
          onChange={(event) => {
            setAuto(event.target.checked);
            try {
              localStorage.setItem(KEY, event.target.checked ? "1" : "0");
            } catch {
              // see above
            }
          }}
          className="size-4 accent-[var(--accent)]"
        />
        Auto-refresh every 30 s
      </label>
      <span role="status" aria-live="polite" className="text-muted">
        {updatedAt !== null && now !== null ? updatedLabel(updatedAt, now) : ""}
      </span>
    </div>
  );
}
