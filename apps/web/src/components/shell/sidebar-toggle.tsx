"use client";

import { PanelLeft } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { type SidebarState, sidebarCookie } from "../../server/sidebar-state";

/** True when the key press belongs to a field, where `[` is just a character. */
function typingIn(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/**
 * Collapses the sidebar to a rail of icons and opens it again: with the button, or with `[` anywhere but in a field.
 * The state lives on the shell (`data-sidebar`) so the CSS does the work, and in a cookie so the server draws the same
 * thing on the next page. Only the desktop sidebar changes; below `md` the menu is the drawer.
 */
export function SidebarToggle({ initial }: { initial: SidebarState }) {
  const [state, setState] = useState<SidebarState>(initial);

  const apply = useCallback((next: SidebarState) => {
    document.getElementById("app-shell")?.setAttribute("data-sidebar", next);
    try {
      document.cookie = sidebarCookie(next, window.location.protocol === "https:");
    } catch {
      // Not remembered; the sidebar still changes for this page.
    }
    setState(next);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "[" || event.metaKey || event.ctrlKey || event.altKey || typingIn(event.target)) return;
      event.preventDefault();
      apply(state === "open" ? "rail" : "open");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state, apply]);

  const open = state === "open";
  const label = open ? "Collapse the sidebar" : "Expand the sidebar";
  return (
    <button
      type="button"
      onClick={() => apply(open ? "rail" : "open")}
      aria-label={label}
      aria-expanded={open}
      aria-controls="app-sidebar"
      title={`${label} ( [ )`}
      className="hidden size-9 items-center justify-center rounded-md text-muted transition-[color,background-color,transform] duration-150 hover:bg-panel-hover hover:text-foreground active:scale-95 md:inline-flex"
    >
      <PanelLeft aria-hidden className={`size-5 transition-transform duration-200 ${open ? "" : "-scale-x-100"}`} />
    </button>
  );
}
