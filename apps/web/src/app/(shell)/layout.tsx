import { readSignInMode } from "@epnexo/core/auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { MobileNav } from "../../components/shell/mobile-nav";
import { SidebarNav } from "../../components/shell/sidebar-nav";
import { ThemeToggle } from "../../components/shell/theme-toggle";
import { SignOutButton } from "../../components/sign-out-button";
import { navigation } from "../../generated/modules";
import { groupNavigation, subjectCan } from "../../server/nav";
import type { Subject } from "../../server/nav";
import { platform } from "../../server/platform";
import { sessionIsUsable } from "../../server/session";

// Every page inside the shell depends on who is asking.
export const dynamic = "force-dynamic";

export default async function ShellLayout({ children }: { children: ReactNode }) {
  const { pool, auth } = platform();
  const mode = await readSignInMode(pool);

  let subject: Subject;
  let who: string | null = null;
  if (mode === "disabled") {
    subject = { kind: "operator" };
  } else {
    const session = await auth.api.getSession({ headers: await headers() });
    // The proxy has already turned this visitor away; this is the same rule at the point of use.
    if (session === null || !sessionIsUsable(session.user)) redirect("/login");
    subject = { kind: "user", role: session.user.role };
    who = session.user.email;
  }
  const groups = groupNavigation(navigation, (permission) => subjectCan(subject, permission));

  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh w-(--sidebar-width) shrink-0 flex-col gap-6 border-r border-border bg-panel p-4 md:flex">
        <span className="px-2.5 font-semibold tracking-tight">epnexo</span>
        <SidebarNav groups={groups} />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-(--topbar-height) items-center gap-2 border-b border-border bg-background/90 px-4 backdrop-blur">
          <MobileNav>
            <SidebarNav groups={groups} />
          </MobileNav>
          <span className="font-semibold tracking-tight md:hidden">epnexo</span>
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
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-8">{children}</main>
      </div>
    </div>
  );
}
