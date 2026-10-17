"use client";

import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";

export interface TabItem {
  id: string;
  label: string;
  content: ReactNode;
}

/**
 * The menu rule of this shell: a screen with more than one concern shows one concern at a time, behind tabs, and
 * anything occasional (adding, uploading, resetting) opens on demand instead of sitting on the page. The tab is
 * kept in the address (`#id`) so a link or a reload lands on it. Controlled when `value` is given.
 */
export function Tabs({ tabs, label, actions, value, onValueChange }: { tabs: TabItem[]; label: string; actions?: ReactNode; value?: string; onValueChange?: (id: string) => void }) {
  const [inner, setInner] = useState(tabs[0]!.id);
  const current = tabs.some((tab) => tab.id === (value ?? inner)) ? (value ?? inner) : tabs[0]!.id;
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const select = (id: string) => {
    setInner(id);
    onValueChange?.(id);
    try {
      history.replaceState(null, "", `#${id}`);
    } catch {
      // The address is only a convenience.
    }
  };

  // Read the address after the first render, so the server and the first client render agree.
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (tabs.some((tab) => tab.id === id)) {
      setInner(id);
      onValueChange?.(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const at = tabs.findIndex((tab) => tab.id === current);
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (event.key === "Home" || event.key === "End" || step !== 0) {
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (at + step + tabs.length) % tabs.length;
      const id = tabs[next]!.id;
      select(id);
      refs.current[id]?.focus();
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border">
        <div role="tablist" aria-label={label} onKeyDown={onKeyDown} className="-mb-px flex max-w-full gap-1 overflow-x-auto">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              ref={(node) => {
                refs.current[tab.id] = node;
              }}
              type="button"
              role="tab"
              id={`tab-${tab.id}`}
              aria-selected={current === tab.id}
              aria-controls={`panel-${tab.id}`}
              tabIndex={current === tab.id ? 0 : -1}
              onClick={() => select(tab.id)}
              className={
                "shrink-0 border-b-2 px-3 py-2 text-sm font-medium transition-colors duration-150 " +
                (current === tab.id ? "border-accent text-foreground" : "border-transparent text-muted hover:text-foreground")
              }
            >
              {tab.label}
            </button>
          ))}
        </div>
        {actions !== undefined ? <div className="mb-2">{actions}</div> : null}
      </div>
      {tabs.map((tab) =>
        current === tab.id ? (
          <div key={tab.id} id={`panel-${tab.id}`} role="tabpanel" aria-labelledby={`tab-${tab.id}`} tabIndex={0} className="flex flex-col gap-6 outline-none">
            {tab.content}
          </div>
        ) : null,
      )}
    </div>
  );
}
