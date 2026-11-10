"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { X } from "lucide-react";
import type { ReactNode } from "react";

/**
 * The sliding drawer itself. It is a separate file so the animation library is downloaded only when someone first opens the
 * menu (see `mobile-nav.tsx`), not with every page of the shell.
 */
export default function MobileDrawer({ open, onClose, children, brand }: { open: boolean; onClose: () => void; children: ReactNode; brand: ReactNode }) {
  const reduced = useReducedMotion();
  const slide = reduced ? { duration: 0 } : { duration: 0.2, ease: [0.16, 1, 0.3, 1] as const };

  return (
    <AnimatePresence>
      {open ? (
        <div className="fixed inset-0 z-40 md:hidden">
          <motion.div
            className="absolute inset-0 bg-foreground/30"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={slide}
            onClick={onClose}
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
                onClick={onClose}
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
  );
}
