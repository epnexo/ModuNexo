"use client";

import { Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { type SettingsIndexEntry, searchSettings } from "../../server/settings-index";

/**
 * One search box for every setting: type part of a label, its help text or a module's name and go straight to it. The
 * index holds labels and links only (see `buildSettingsIndex`), so no value is ever sent to the browser for this.
 */
export function SettingsSearch({ index }: { index: SettingsIndexEntry[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const listId = useId();
  const results = searchSettings(index, query);
  const showing = open && query.trim() !== "";

  useEffect(() => {
    const away = (event: PointerEvent) => {
      if (box.current !== null && !box.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, []);

  function go(entry: SettingsIndexEntry) {
    const tab = entry.href.split("#")[1];
    router.push(entry.href, { scroll: false });
    // The tabs read the address once; tell them which one to show now.
    if (tab !== undefined) window.dispatchEvent(new CustomEvent("modunexo:tab", { detail: tab }));
    setQuery("");
    setOpen(false);
  }

  return (
    <div ref={box} className="relative w-full sm:w-80">
      <label htmlFor={`${listId}-input`} className="sr-only">
        Search every setting
      </label>
      <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
      <input
        id={`${listId}-input`}
        type="search"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setQuery("");
            setOpen(false);
          }
          if (event.key === "Enter" && results[0] !== undefined) {
            event.preventDefault();
            go(results[0]);
          }
        }}
        placeholder="Search every setting"
        autoComplete="off"
        aria-controls={listId}
        aria-expanded={showing}
        className="h-10 w-full rounded-md border border-border-strong bg-surface pr-3 pl-9 text-sm outline-none transition-colors duration-150 focus-visible:border-accent"
      />
      <p role="status" className="sr-only">
        {showing ? `${results.length} ${results.length === 1 ? "setting" : "settings"} found` : ""}
      </p>
      {showing ? (
        <ul id={listId} className="absolute top-full right-0 left-0 z-30 mt-1 flex max-h-96 flex-col gap-0.5 overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-raised">
          {results.length === 0 ? (
            <li className="px-3 py-2 text-sm text-muted">No setting matches.</li>
          ) : (
            results.map((entry) => (
              <li key={`${entry.href}:${entry.label}`}>
                <a
                  href={entry.href}
                  onClick={(event) => {
                    event.preventDefault();
                    go(entry);
                  }}
                  className="flex flex-col rounded-md px-3 py-2 text-sm transition-colors duration-150 hover:bg-panel-hover focus-visible:bg-panel-hover"
                >
                  <span className="font-medium">{entry.label}</span>
                  <span className="text-xs text-muted">{entry.description === "" ? entry.where : `${entry.where} · ${entry.description}`}</span>
                </a>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
