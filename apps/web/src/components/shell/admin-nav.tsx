"use client";

import { ChevronRight } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { ADMIN_ENTRIES, isAdminPath } from "../../server/nav";
import { NavLink } from "./nav-link";

/** The collapsible Admin block at the bottom of the sidebar. It opens by itself while the current page is inside it. */
export function AdminNav() {
  const pathname = usePathname();
  const inside = isAdminPath(pathname);
  const [open, setOpen] = useState(inside);
  const listId = useId();

  // Arriving at an admin page by a link elsewhere opens the block; leaving does not close what the person opened.
  useEffect(() => {
    if (inside) setOpen(true);
  }, [inside]);

  return (
    <div className="nav-group nav-admin mt-auto flex flex-col gap-0.5 border-t border-border pt-3" data-open={open}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={listId}
        className="nav-group-btn flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm text-muted transition-colors duration-150 hover:bg-panel-hover hover:text-foreground"
      >
        <ChevronRight aria-hidden className="nav-chev size-4" />
        Admin
      </button>
      <div className="nav-group-body">
        <ul id={listId} className="nav-group-list ml-4 flex flex-col gap-0.5 border-l border-border pl-2">
          {ADMIN_ENTRIES.map((item) => (
            <li key={item.href}>
              <NavLink href={item.href} label={item.label} icon={item.icon} />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
