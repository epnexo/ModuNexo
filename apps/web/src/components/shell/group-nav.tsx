"use client";

import { ChevronRight } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { type NavGroup, groupHasActive, parseCollapsed, resolveIcon, toggleCollapsed } from "../../server/nav";
import { NavLink } from "./nav-link";

const STORAGE_KEY = "modunexo.nav.collapsed";

/** A per-viewer convenience: the browser may refuse storage, and the sidebar must work without it. */
function readCollapsed(): string[] {
  try {
    return parseCollapsed(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return [];
  }
}

function writeCollapsed(collapsed: string[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(collapsed));
  } catch {
    // Not remembered; the block still opens and closes.
  }
}

/** A titled block of the sidebar that opens and closes like Admin. It starts open, and a page inside it keeps it open. */
export function GroupNav({ group }: { group: NavGroup & { label: string } }) {
  const pathname = usePathname();
  const inside = groupHasActive(group, pathname);
  const [collapsed, setCollapsed] = useState(false);
  const listId = useId();

  // What the person closed earlier is read after the first paint, so the server and the browser draw the same thing first.
  useEffect(() => {
    setCollapsed(readCollapsed().includes(group.label));
  }, [group.label]);

  const open = !collapsed || inside;
  function toggle() {
    const next = toggleCollapsed(readCollapsed(), group.label);
    writeCollapsed(next);
    setCollapsed(next.includes(group.label));
  }

  return (
    <div className="nav-group flex flex-col gap-1" data-open={open}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={listId}
        className="nav-group-btn flex h-9 items-center gap-2 rounded-md px-2.5 text-sm font-semibold text-foreground transition-colors duration-150 hover:bg-panel-hover"
      >
        <ChevronRight aria-hidden className="nav-chev size-4 text-muted" />
        {group.label}
      </button>
      <div className="nav-group-body">
        <ul id={listId} className="nav-group-list ml-4 flex flex-col gap-0.5 border-l border-border pl-2">
          {group.entries.map((entry) => (
            <li key={`${entry.moduleId}:${entry.href}`}>
              <NavLink href={entry.href} label={entry.label} icon={resolveIcon(entry.icon)} />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
