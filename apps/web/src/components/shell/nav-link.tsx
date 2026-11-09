"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { type IconName, isActive } from "../../server/nav";
import { NavIcon } from "./icon";

/**
 * One entry of the sidebar. The name is also the `title` and the accessible name, because on the collapsed rail the text
 * is hidden and the icon alone must still say where the link goes.
 */
export function NavLink({ href, label, icon }: { href: string; label: string; icon: IconName }) {
  const pathname = usePathname();
  const active = isActive(pathname, href);
  return (
    <Link
      href={href}
      title={label}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      className={
        "nav-link flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm transition-[color,background-color,transform] duration-150 active:scale-[0.98] " +
        (active ? "bg-accent-soft font-medium text-accent-soft-foreground" : "text-muted hover:bg-panel-hover hover:text-foreground")
      }
    >
      <NavIcon name={icon} />
      <span className="nav-txt">{label}</span>
    </Link>
  );
}
