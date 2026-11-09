"use client";

import Link from "next/link";
import { type ReactNode, useId, useState } from "react";
import type { PickerEntry } from "../../server/module-picker";

/**
 * Settings of one module at a time: a searchable list on the left and, on the right, only the module that is selected.
 * The list is made of links (`?module=<id>`), so a choice survives a reload, can be shared, and is rendered by the server,
 * which describes only that one module. Below the `md` breakpoint the list sits above the panel.
 */
export function ModulePicker({ entries, selected, children }: { entries: PickerEntry[]; selected: string; children: ReactNode }) {
  const [query, setQuery] = useState("");
  const searchId = useId();
  const needle = query.trim().toLowerCase();
  const shown = needle === "" ? entries : entries.filter((entry) => `${entry.name} ${entry.id}`.toLowerCase().includes(needle));

  return (
    <div className="grid items-start gap-5 md:grid-cols-[minmax(13rem,17rem)_1fr]">
      <div className="flex flex-col gap-2 md:sticky md:top-20">
        <label htmlFor={searchId} className="sr-only">
          Find a module
        </label>
        <input
          id={searchId}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find a module"
          autoComplete="off"
          className="h-10 rounded-md border border-border-strong bg-surface px-3 text-sm outline-none transition-colors duration-150 focus-visible:border-accent"
        />
        <nav aria-label="Modules">
          <ul className="flex max-h-72 flex-col gap-0.5 overflow-y-auto overscroll-contain md:max-h-[calc(100dvh-10rem)]">
            {shown.length === 0 ? (
              <li className="px-3 py-2 text-sm text-muted">No module matches.</li>
            ) : (
              shown.map((entry) => (
                <li key={entry.id}>
                  <Link
                    href={`/settings?module=${encodeURIComponent(entry.id)}#modules`}
                    scroll={false}
                    aria-current={entry.id === selected ? "true" : undefined}
                    className={
                      "flex min-h-10 items-center rounded-md px-3 text-sm transition-colors duration-150 " +
                      (entry.id === selected ? "bg-accent-soft font-semibold text-accent-soft-foreground" : "hover:bg-panel-hover")
                    }
                  >
                    {entry.name}
                  </Link>
                </li>
              ))
            )}
          </ul>
        </nav>
      </div>
      <div className="flex min-w-0 flex-col gap-4">{children}</div>
    </div>
  );
}
