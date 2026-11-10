import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { BarChart } from "../../components/dashboard/bar-chart";
import { AlertsList } from "../../components/dashboard/alerts-list";
import { LiveRefresh } from "../../components/dashboard/live-refresh";
import { loadDashboard } from "../../server/dashboard-data";
import type { DashboardView } from "../../server/dashboard";
import { resolveViewer } from "../../server/viewer";

export const metadata: Metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

const link = "font-medium text-accent underline-offset-4 hover:underline";
const TONE: Record<DashboardView["headline"]["tone"], string> = {
  ok: "bg-success-soft",
  info: "bg-surface border border-border",
  warning: "bg-warning-soft",
  error: "bg-danger-soft text-danger-soft-foreground",
};

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`${id}-heading`} className="flex flex-col gap-3">
      <h2 id={`${id}-heading`} className="text-lg font-semibold tracking-tight">
        {title}
      </h2>
      {children}
    </section>
  );
}

export default async function DashboardPage() {
  const viewer = await resolveViewer(await headers());
  if (viewer === null) redirect("/login");
  const view = await loadDashboard(viewer);

  if (view.empty) {
    return (
      <div className="flex max-w-xl flex-col gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-muted">
          No modules are installed yet. Modules add pages to this sidebar and report their figures here.
          {viewer.canWrite ? (
            <>
              {" "}
              Install the first one from the{" "}
              <Link className={link} href="/apps">
                Apps
              </Link>{" "}
              screen.
            </>
          ) : null}
        </p>
      </div>
    );
  }

  if (view.hidden) {
    return (
      <div className="flex max-w-xl flex-col gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-muted">Nothing to show you yet. The enabled modules report only to people who hold their permissions.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p role="status" className={`max-w-xl rounded-md px-3 py-2 text-sm font-medium ${TONE[view.headline.tone]}`}>
          {view.headline.text}
        </p>
        <LiveRefresh />
      </div>

      {view.alerts.length === 0 ? null : (
        <Section id="alerts" title="Needs attention">
          <AlertsList alerts={view.alerts} />
        </Section>
      )}

      {view.charts.length === 0 ? null : (
        <Section id="charts" title="Charts">
          <div className="flex flex-col gap-4">
            {view.charts.map((chart) => (
              <BarChart key={chart.key} chart={chart} />
            ))}
          </div>
        </Section>
      )}

      {view.modules.length === 0 ? null : (
        <Section id="figures" title="Modules">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {view.modules.map((module) => (
              <div key={module.id} className="card flex flex-col gap-3">
                <h3 className="text-sm font-medium text-muted">{module.name}</h3>
                <ul className="flex flex-col gap-2">
                  {module.stats.map((stat) => (
                    <li key={stat.key}>
                      <Link href={stat.href} className="flex items-baseline justify-between gap-3 rounded-md px-2 py-1 -mx-2 transition-colors duration-150 hover:bg-panel-hover focus-visible:bg-panel-hover">
                        <span className="text-sm">{stat.label}</span>
                        <span className="text-lg font-semibold tabular-nums">{stat.value}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Section>
      )}

      {view.silent.length === 0 ? null : (
        <p className="max-w-2xl text-sm text-muted">
          Not reporting to the dashboard: {view.silent.join(", ")}. A module opts in by declaring a <code>dashboard</code> in its manifest.
        </p>
      )}

      {view.platform === null ? null : (
        <Section id="platform" title="Platform">
          <dl className="grid max-w-xl grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
            <dt className="text-muted">Modules</dt>
            <dd>{view.platform.modules}</dd>
            <dt className="text-muted">Jobs</dt>
            <dd>{view.platform.jobs}</dd>
          </dl>
          {view.activity.length === 0 ? (
            <p className="text-sm text-muted">No activity yet.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface">
              {view.activity.map((entry, index) => (
                <li key={index} className="flex flex-wrap items-center gap-x-3 px-4 py-2 text-sm">
                  <Link className={`${link} min-w-0 flex-1 break-all`} href={entry.href}>
                    {entry.text}
                  </Link>
                  <span className="text-muted">{entry.when}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}
    </div>
  );
}
