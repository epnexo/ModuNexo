"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/**
 * Fades the page in when the address changes (another module, another screen, another tab of a module that has its own
 * address). The key restarts the CSS animation of `.page-enter`; nothing else is remounted above it, and a change that only
 * touches the query string (a filter) does not replay it. With reduced motion the stylesheet turns the animation off.
 */
export function PageEnter({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <div key={pathname} className="page-enter">
      {children}
    </div>
  );
}
