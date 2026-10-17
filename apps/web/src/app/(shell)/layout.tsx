import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { BrandFooter } from "../../components/brand/brand-footer";
import { BrandMark } from "../../components/brand/brand-mark";
import { AppearanceHead } from "../../components/appearance-head";
import { MobileNav } from "../../components/shell/mobile-nav";
import { ModuleScope } from "../../components/shell/module-scope";
import { SidebarNav } from "../../components/shell/sidebar-nav";
import { ThemeToggle } from "../../components/shell/theme-toggle";
import { SignOutButton } from "../../components/sign-out-button";
import { modules, navigation } from "../../generated/modules";
import { loadBrand } from "../../server/brand";
import { moduleScopes } from "../../server/module-scope";
import { groupNavigation, subjectCan } from "../../server/nav";
import { resolveViewer } from "../../server/viewer";

// Every page inside the shell depends on who is asking.
export const dynamic = "force-dynamic";

export default async function ShellLayout({ children }: { children: ReactNode }) {
  const viewer = await resolveViewer(await headers());
  // The proxy has already turned this visitor away; this is the same rule at the point of use.
  if (viewer === null) redirect("/login");
  const who = viewer.email;
  const groups = groupNavigation(navigation, (permission) => subjectCan(viewer.subject, permission));
  const scopes = moduleScopes(modules);
  const brand = await loadBrand();
  // The platform has no identity until the administrator has been through the setup.
  if (brand.profile === null) redirect("/setup");

  return (
    <div className="flex min-h-dvh">
      <AppearanceHead />
      <aside className="sticky top-0 hidden h-dvh w-(--sidebar-width) shrink-0 flex-col gap-6 border-r border-border bg-panel p-4 md:flex">
        <div className="px-2.5">
          <BrandMark profile={brand.profile} logo={brand.logo} />
        </div>
        <SidebarNav groups={groups} />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-(--topbar-height) items-center gap-2 border-b border-border bg-background/90 px-4 backdrop-blur">
          <MobileNav brand={<BrandMark profile={brand.profile} logo={brand.logo} />}>
            <SidebarNav groups={groups} />
          </MobileNav>
          <div className="min-w-0 md:hidden">
            <BrandMark profile={brand.profile} logo={brand.logo} size={24} />
          </div>
          <div className="ml-auto flex items-center gap-2">
            {who === null ? (
              <span className="rounded-md bg-warning-soft px-2 py-1 text-xs font-medium" title="Sign-in is switched off; this shell serves the local network only.">
                Local operator · sign-in off
              </span>
            ) : (
              <>
                <span className="hidden text-sm text-muted sm:inline">{who}</span>
                <SignOutButton />
              </>
            )}
            <ThemeToggle />
          </div>
        </header>
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-8">
          <ModuleScope scopes={scopes}>{children}</ModuleScope>
        </main>
        <BrandFooter profile={brand.profile} />
      </div>
    </div>
  );
}
