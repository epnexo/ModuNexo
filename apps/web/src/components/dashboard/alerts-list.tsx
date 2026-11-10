"use client";

import Link from "next/link";
import { useState } from "react";
import type { AlertRow } from "../../server/dashboard";
import { type SeverityFilter, filterAlerts, severityCounts } from "../../server/dashboard-live";

const SEVERITY_LABEL: Record<AlertRow["severity"], string> = { error: "Error", warning: "Warning", info: "Info" };
const FILTERS: { id: SeverityFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "error", label: "Errors" },
  { id: "warning", label: "Warnings" },
  { id: "info", label: "Info" },
];
const link = "font-medium text-accent underline-offset-4 hover:underline";

/** The alerts, with a filter by severity when there is more than one kind to tell apart. The list itself is data from the server. */
export function AlertsList({ alerts }: { alerts: AlertRow[] }) {
  const [filter, setFilter] = useState<SeverityFilter>("all");
  const counts = severityCounts(alerts);
  const kinds = (["error", "warning", "info"] as const).filter((severity) => counts[severity] > 0).length;
  const shown = filterAlerts(alerts, filter);

  return (
    <div className="flex flex-col gap-3">
      {kinds > 1 ? (
        <div role="group" aria-label="Filter alerts by severity" className="flex flex-wrap gap-2">
          {FILTERS.filter((option) => option.id === "all" || counts[option.id] > 0).map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={filter === option.id}
              onClick={() => setFilter(option.id)}
              className={
                "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-sm transition-colors duration-150 " +
                (filter === option.id ? "border-accent bg-accent-soft font-semibold text-accent-soft-foreground" : "border-border-strong bg-surface hover:bg-panel-hover")
              }
            >
              {option.label}
              <span className="tabular-nums text-muted">{counts[option.id]}</span>
            </button>
          ))}
        </div>
      ) : null}
      <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface">
        {shown.map((alert) => (
          <li key={alert.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm">
            <span className="w-16 shrink-0 text-xs font-medium uppercase tracking-wide text-muted">{SEVERITY_LABEL[alert.severity]}</span>
            <span className="min-w-0 flex-1">
              <span className="font-medium">{alert.label}</span> <span className="text-muted">· {alert.source}</span>
            </span>
            {alert.detail === "" ? null : <span className="tabular-nums text-muted">{alert.detail}</span>}
            {alert.when === null ? null : <span className="text-muted">{alert.when}</span>}
            <Link className={link} href={alert.href}>
              Open
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
