"use client";

import { Menu } from "lucide-react";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";

// The drawer (and the animation library it uses) is fetched the first time the menu is asked for. `preload` starts that
// download on pointer-down or focus, so it is usually there by the time the click lands.
const loadDrawer = () => import("./mobile-drawer");
const MobileDrawer = dynamic(loadDrawer, { ssr: false });

/** The sidebar as a drawer below the `md` breakpoint. The navigation itself is rendered by the server. */
export function MobileNav({ children, brand }: { children: ReactNode; brand: ReactNode }) {
  const [open, setOpen] = useState(false);
  // Once opened the drawer stays mounted, so it can play its exit animation.
  const [wanted, setWanted] = useState(false);
  const pathname = usePathname();

  // A link was followed: the drawer has done its job.
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setWanted(true);
          setOpen(true);
        }}
        onPointerDown={() => void loadDrawer()}
        onFocus={() => void loadDrawer()}
        aria-label="Open the menu"
        aria-expanded={open}
        className="inline-flex size-9 items-center justify-center rounded-md text-muted transition-colors duration-150 hover:bg-panel-hover hover:text-foreground md:hidden"
      >
        <Menu aria-hidden className="size-5" />
      </button>
      {wanted ? (
        <MobileDrawer open={open} onClose={() => setOpen(false)} brand={brand}>
          {children}
        </MobileDrawer>
      ) : null}
    </>
  );
}
