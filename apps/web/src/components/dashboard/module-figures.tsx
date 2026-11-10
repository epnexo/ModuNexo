"use client";

import { Search } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { DashboardView } from "../../server/dashboard";
import { MODULE_SEARCH_FROM, filterModules } from "../../server/dashboard-live";
import { NavIcon } from "../shell/icon";

/** The module cards, with a search box over their names and figures once there are enough of them to need one. */
export function ModuleFigures({ modules }: { modules: DashboardView["modules"] }) {
  const [query, setQuery] = useState("");
  const shown = filterModules(modules, query);

  return (
    <div className="flex flex-col gap-4">
      {modules.length < MODULE_SEARCH_FROM ? null : (
        <div className="flex flex-wrap items-center gap-3">
          <label className="relative block w-full max-w-xs">
            <span className="sr-only">Search modules and figures</span>
            <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search modules and figures"
              className="h-10 w-full rounded-md border border-border-strong bg-surface pl-9 pr-3 text-sm outline-none transition-colors duration-150 focus-visible:border-accent"
            />
          </label>
          <p role="status" className="text-sm text-muted tabular-nums">
            {query.trim() === "" ? `${modules.length} modules` : `${shown.length} of ${modules.length} modules`}
          </p>
        </div>
      )}
      {shown.length === 0 ? (
        <p className="text-sm text-muted">No module or figure matches “{query.trim()}”.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((module) => (
            <div key={module.id} className="card flex flex-col gap-3">
              <div className="flex items-center gap-2.5">
                <span className="icon-tile">
                  <NavIcon name={module.icon} />
                </span>
                <h3 className="text-sm font-medium text-muted">{module.name}</h3>
              </div>
              <ul className="flex flex-col gap-2">
                {module.stats.map((stat) => (
                  <li key={stat.key}>
                    <Link href={stat.href} className="-mx-2 flex items-baseline justify-between gap-3 rounded-md px-2 py-1 transition-colors duration-150 hover:bg-panel-hover focus-visible:bg-panel-hover">
                      <span className="text-sm">{stat.label}</span>
                      <span className="text-lg font-semibold tabular-nums">{stat.value}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
