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

/** How a bar grows from its base: 820 ms, each bar 65 ms after the one before, the delay capped so a long chart does not make anyone wait. */
export const BAR_MS = 820;
export const BAR_STAGGER_MS = 65;
export const BAR_MAX_DELAY_MS = 585;
export function barAnimation(index: number): { duration: number; delay: number; easing: string } {
  return { duration: BAR_MS, delay: Math.min(index * BAR_STAGGER_MS, BAR_MAX_DELAY_MS), easing: "cubic-bezier(.22, .78, .26, 1)" };
}
/** The value above a bar fades in a little after the bar starts growing. */
export function valueAnimation(index: number): { duration: number; delay: number } {
  return { duration: 350, delay: barAnimation(index).delay + 340 };
}

/** What a bar says when it is hovered or focused: its label and value, and how far it is from the chart's average when there is one. */
export function barReadout(label: string, value: number, average: number | null): string {
  const base = `${label}: ${value.toLocaleString("en-US")}`;
  if (average === null || average === 0) return base;
  const percent = Math.round(((value - average) / average) * 100);
  if (percent === 0) return `${base} · at the average`;
  return `${base} · ${Math.abs(percent)}% ${percent > 0 ? "above" : "below"} the average`;
}

/** The bar a key moves to from `current`, or null when the key is not one the chart handles. The ends stop; they do not wrap. */
export function stepBar(key: string, current: number, count: number): number | null {
  if (count <= 0) return null;
  if (key === "ArrowRight") return Math.min(current + 1, count - 1);
  if (key === "ArrowLeft") return Math.max(current - 1, 0);
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

/** The module cards whose name or one of whose figures' names contains the search text, in their order. Blank text keeps all. */
export function filterModules<T extends { name: string; stats: readonly { label: string }[] }>(modules: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...modules];
  return modules.filter((entry) => entry.name.toLowerCase().includes(needle) || entry.stats.some((stat) => stat.label.toLowerCase().includes(needle)));
}

/** A search box earns its place only when there is more to look through than fits at a glance. */
export const MODULE_SEARCH_FROM = 4;

/** The storage key of a section's folded state, one per section so each remembers its own. */
export const foldKey = (section: string): string => `modunexo.dashboard.fold.${section}`;
