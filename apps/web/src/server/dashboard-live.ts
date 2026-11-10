import type { AlertRow } from "./dashboard";

/** Pure helpers for the interactive parts of the dashboard. They hold no data of their own: they only filter and describe what the server rendered. */

export type SeverityFilter = "all" | AlertRow["severity"];

/** Between two automatic refreshes. Each one re-runs the page on the server (permissions included), so it is never shorter than this. */
export const AUTO_REFRESH_MS = 30_000;

export function filterAlerts(alerts: readonly AlertRow[], filter: SeverityFilter): AlertRow[] {
  return filter === "all" ? [...alerts] : alerts.filter((alert) => alert.severity === filter);
}

export function severityCounts(alerts: readonly AlertRow[]): Record<SeverityFilter, number> {
  const counts: Record<SeverityFilter, number> = { all: alerts.length, error: 0, warning: 0, info: 0 };
  for (const alert of alerts) counts[alert.severity] += 1;
  return counts;
}

/** Automatic refresh runs only while the person can see the page: a hidden tab costs the server nothing. */
export function shouldAutoRefresh(enabled: boolean, visibility: DocumentVisibilityState): boolean {
  return enabled && visibility === "visible";
}

export function updatedLabel(updatedAt: Date, now: Date): string {
  const seconds = Math.max(0, Math.round((now.getTime() - updatedAt.getTime()) / 1000));
  if (seconds < 10) return "Updated just now";
  if (seconds < 60) return `Updated ${seconds} s ago`;
  return `Updated ${Math.round(seconds / 60)} min ago`;
}
