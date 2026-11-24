import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ProposalButtons } from "../../../components/actions/proposal-buttons";
import { RunActionForm } from "../../../components/actions/run-action-form";
import { buildActionsView, type ProposalRow } from "../../../server/actions-view";
import { actionService } from "../../../server/actions-deps";
import { subjectCan } from "../../../server/nav";
import { resolveViewer } from "../../../server/viewer";

export const metadata: Metadata = { title: "Actions" };
export const dynamic = "force-dynamic";

const when = (iso: string) => iso.slice(0, 16).replace("T", " ");

function Facts({ row }: { row: ProposalRow }) {
  return (
    <p className="text-sm text-muted">
      Proposed by <span className="font-medium text-foreground">{row.proposedBy}</span> on {when(row.proposedAt)}
      {row.state === "pending" ? `, expires ${when(row.expiresAt)}` : ""}.
    </p>
  );
}

export default async function ActionsPage() {
  const viewer = await resolveViewer(await headers());
  if (viewer === null) redirect("/login");

  if (!viewer.canWrite) {
    return (
      <div className="flex max-w-xl flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Actions</h1>
        <p className="text-muted">Only an administrator can decide what an agent proposes.</p>
      </div>
    );
  }

  const service = actionService();
  // Waiting ones are asked for on their own, so a busy week of settled rows can never push one out of the list.
  const [catalog, pending, recent] = await Promise.all([service.catalog(), service.list({ status: "pending", limit: 100 }), service.list({ limit: 100 })]);
  const proposals = [...pending, ...recent.filter((proposal) => proposal.status !== "pending")];
  const view = buildActionsView({ catalog, proposals, can: (permission) => subjectCan(viewer.subject, permission) });

  return (
    <div className="flex max-w-4xl flex-col gap-10">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Actions</h1>
        <p className="text-muted">What the modules let an agent do. An agent can only propose a change: it waits here for a person to approve it, and expires after seven days.</p>
      </div>

      <section aria-labelledby="waiting-heading" data-guard className="flex flex-col gap-3">
        <h2 id="waiting-heading" className="section-title m-0">
          Waiting for a decision
        </h2>
        {view.waiting.length === 0 ? <p className="empty">Nothing is waiting.</p> : null}
        {view.waiting.map((row) => (
          <article key={row.id} className="card flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="section-title m-0">{row.label}</h3>
              <span className="badge badge-warning">{row.risk}</span>
              <span className="text-sm text-muted">{row.ref}</span>
            </div>
            <Facts row={row} />
            <pre className="whitespace-pre-wrap rounded-md border border-border bg-panel p-3 text-sm">{row.input}</pre>
            <ProposalButtons id={row.id} canDecide={row.canDecide} />
          </article>
        ))}
      </section>

      <section aria-labelledby="run-heading" className="flex flex-col gap-3">
        <h2 id="run-heading" className="section-title m-0">
          Run an action
        </h2>
        {view.runnable.length === 0 ? <p className="empty">No enabled module offers an action yet.</p> : null}
        {view.runnable.map((action) => (
          <RunActionForm key={action.ref} action={action} />
        ))}
      </section>

      <section aria-labelledby="history-heading" className="flex flex-col gap-3">
        <h2 id="history-heading" className="section-title m-0">
          What happened
        </h2>
        {view.history.length === 0 ? <p className="empty">Nothing yet.</p> : null}
        {view.history.length === 0 ? null : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Action</th>
                  <th>Proposed by</th>
                  <th>State</th>
                  <th>Decided by</th>
                </tr>
              </thead>
              <tbody>
                {view.history.map((row) => (
                  <tr key={row.id}>
                    <td>{when(row.proposedAt)}</td>
                    <td>{row.label}</td>
                    <td>{row.proposedBy}</td>
                    <td>
                      {row.state}
                      {row.error === null ? "" : `: ${row.error}`}
                    </td>
                    <td>
                      {row.decidedBy ?? "-"}
                      {row.decisionNote === null ? "" : ` (${row.decisionNote})`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
