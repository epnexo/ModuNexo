"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Menu, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";

/** The sidebar as a drawer below the `md` breakpoint. The navigation itself is rendered by the server. */
export function MobileNav({ children, brand }: { children: ReactNode; brand: ReactNode }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const reduced = useReducedMotion();

  // A link was followed: the drawer has done its job.
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const slide = reduced ? { duration: 0 } : { duration: 0.2, ease: [0.16, 1, 0.3, 1] as const };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open the menu"
        aria-expanded={open}
        className="inline-flex size-9 items-center justify-center rounded-md text-muted transition-colors duration-150 hover:bg-panel-hover hover:text-foreground md:hidden"
      >
        <Menu aria-hidden className="size-5" />
      </button>
      <AnimatePresence>
        {open ? (
          <div className="fixed inset-0 z-40 md:hidden">
            <motion.div
              className="absolute inset-0 bg-foreground/30"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={slide}
              onClick={() => setOpen(false)}
            />
            <motion.aside
              role="dialog"
              aria-label="Menu"
              className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col gap-6 border-r border-border bg-panel p-4"
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={slide}
            >
              <div className="flex items-center justify-between">
                <div className="min-w-0">{brand}</div>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close the menu"
                  className="inline-flex size-9 items-center justify-center rounded-md text-muted hover:bg-panel-hover hover:text-foreground"
                >
                  <X aria-hidden className="size-5" />
                </button>
              </div>
              {children}
            </motion.aside>
          </div>
        ) : null}
      </AnimatePresence>
    </>
  );
}
