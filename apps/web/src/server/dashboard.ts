import type { DashboardSeverity } from "@modunexo/sdk";
import type { ModuleCards, PlatformOverview } from "@modunexo/core/dashboard";
import { formatAgo } from "./status.ts";

const NOT_AVAILABLE = "not available";
const SEVERITY_RANK: Record<DashboardSeverity, number> = { error: 0, warning: 1, info: 2 };

export interface DashboardInput {
  cards: ModuleCards;
  /** Given only to an administrator: the platform's own state is not for everyone. */
  overview: PlatformOverview | null;
  /** The line that says jobs wait for a worker nobody started, when there is one. */
  workerLine?: string | null;
  now: Date;
}

export interface AlertRow {
  key: string;
  severity: DashboardSeverity;
  /** "Platform" or the module's name. */
  source: string;
  label: string;
  /** The count, or "not available"; empty for a platform alert. */
  detail: string;
  href: string;
  when: string | null;
}

export interface StatRow {
  key: string;
  label: string;
  value: string;
  href: string;
}

export interface ChartRow {
  key: string;
  label: string;
  source: string;
  href: string;
  bars: { label: string; value: number }[];
  /** The rounded mean of the bars; null when there are none or the chart could not be read. */
  average: number | null;
  /** The tallest bar, the scale the bars are drawn against (0 when there are none). */
  max: number;
  /** False when the module's statement failed: the page says so instead of drawing an empty chart. */
  available: boolean;
}

export interface DashboardView {
  headline: { tone: "ok" | DashboardSeverity; text: string };
  alerts: AlertRow[];
  charts: ChartRow[];
  modules: { id: string; name: string; stats: StatRow[] }[];
  /** Names of enabled modules that contribute nothing. */
  silent: string[];
  platform: { modules: string; jobs: string } | null;
  activity: { text: string; when: string; href: string }[];
  /** No module is enabled, so there is nothing to show. */
  empty: boolean;
  /** Modules are enabled, but this viewer holds no permission to see a card of any of them, and is given no platform block. */
  hidden: boolean;
}

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

/** Everything the dashboard page draws, as plain strings, so the page holds no rules of its own. */
export function buildDashboard({ cards, overview, workerLine = null, now }: DashboardInput): DashboardView {
  const platformAlerts: AlertRow[] = (overview?.alerts ?? []).map((alert) => ({
    key: `${alert.kind}:${alert.moduleId}:${alert.label}`,
    severity: alert.severity,
    source: "Platform",
    label: alert.label,
    detail: "",
    href: alert.href,
    when: alert.at === null ? null : formatAgo(alert.at, now),
  }));
  if (overview !== null && workerLine !== null && workerLine !== "") {
    platformAlerts.push({ key: "worker", severity: "warning", source: "Platform", label: workerLine, detail: "", href: "/status", when: null });
  }
  const moduleAlerts: AlertRow[] = cards.alerts.map((alert) => ({
    key: `${alert.moduleId}:${alert.key}`,
    severity: alert.severity,
    source: alert.moduleName,
    label: alert.label,
    detail: alert.count === null ? NOT_AVAILABLE : String(alert.count),
    href: alert.href,
    when: null,
  }));
  // A stable sort keeps the platform's alerts ahead of a module's of the same severity.
  const alerts = [...platformAlerts, ...moduleAlerts].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

  const worst = alerts[0]?.severity;
  const headline: DashboardView["headline"] =
    alerts.length === 0
      ? { tone: "ok", text: "Everything looks fine." }
      : { tone: worst === "error" ? "error" : worst === "warning" ? "warning" : "info", text: `${alerts.length} ${plural(alerts.length, "thing needs", "things need")} attention.` };

  const byModule = new Map<string, { id: string; name: string; stats: StatRow[] }>();
  for (const stat of cards.stats) {
    const entry = byModule.get(stat.moduleId) ?? { id: stat.moduleId, name: stat.moduleName, stats: [] };
    entry.stats.push({
      key: stat.key,
      label: stat.label,
      value: stat.value === null ? NOT_AVAILABLE : typeof stat.value === "number" ? stat.value.toLocaleString("en-US") : stat.value,
      href: stat.href,
    });
    byModule.set(stat.moduleId, entry);
  }

  const charts: ChartRow[] = cards.charts.map((chart) => {
    const bars = chart.points ?? [];
    return {
      key: `${chart.moduleId}:${chart.key}`,
      label: chart.label,
      source: chart.moduleName,
      href: chart.href,
      bars,
      average: bars.length === 0 ? null : Math.round(bars.reduce((sum, bar) => sum + bar.value, 0) / bars.length),
      max: bars.reduce((tallest, bar) => Math.max(tallest, bar.value), 0),
      available: chart.points !== null,
    };
  });

  const platform = overview === null ? null : { modules: `${overview.modules.enabled} enabled, ${overview.modules.disabled} disabled`, jobs: `${overview.jobs.queued} queued, ${overview.jobs.running} running` };
  const activity = (overview?.activity ?? []).map((entry) => ({ text: entry.text, when: formatAgo(entry.at, now), href: entry.href }));
  const modules = [...byModule.values()];
  const empty = cards.enabled === 0;
  return {
    headline,
    alerts,
    charts,
    modules,
    silent: cards.silent.map((entry) => entry.moduleName),
    platform,
    activity,
    empty,
    hidden: !empty && platform === null && alerts.length === 0 && charts.length === 0 && modules.length === 0 && cards.silent.length === 0,
  };
}
