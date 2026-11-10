"use client";

import { ChevronRight } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { foldKey } from "../../server/dashboard-live";

/**
 * A titled section of the dashboard that can be folded away. The choice is remembered on this device, per section. The
 * first paint is always open, like the server's, and a remembered fold applies right after it. Folded content is taken
 * out of the tab order and hidden from assistive technology once it has finished closing.
 */
export function FoldSection({ id, title, children, aside }: { id: string; title: string; children: ReactNode; aside?: ReactNode }) {
  const [open, setOpen] = useState(true);
  const bodyId = useId();

  useEffect(() => {
    try {
      if (localStorage.getItem(foldKey(id)) === "closed") setOpen(false);
    } catch {
      // A remembered choice is only a convenience.
    }
  }, [id]);

  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem(foldKey(id), open ? "closed" : "open");
    } catch {
      // The section still folds for this visit.
    }
  };

  return (
    <section aria-labelledby={`${id}-heading`} className="fold flex flex-col gap-3" data-open={open}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={`${id}-heading`} className="text-lg font-semibold tracking-tight">
          <button type="button" onClick={toggle} aria-expanded={open} aria-controls={bodyId} className="-mx-2 inline-flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors duration-150 hover:bg-panel-hover">
            <ChevronRight aria-hidden className="fold-chev size-4 text-muted" />
            {title}
          </button>
        </h2>
        {open ? aside : null}
      </div>
      <div id={bodyId} className="fold-body">
        <div className="fold-inner">{children}</div>
      </div>
    </section>
  );
}
