"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { isActive } from "../../server/nav";

export function NavLink({ href, children }: { href: string; children: ReactNode }) {
  const pathname = usePathname();
  const active = isActive(pathname, href);
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={
        "flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors duration-150 " +
        (active ? "bg-accent-soft font-medium text-accent-soft-foreground" : "text-muted hover:bg-panel-hover hover:text-foreground")
      }
    >
      {children}
    </Link>
  );
}
