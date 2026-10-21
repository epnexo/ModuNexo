import { EventService } from "@modunexo/core/events";
import { FileService, defaultFileStorage } from "@modunexo/core/files";
import { JOB_STATUSES, JobService } from "@modunexo/core/jobs";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { ProbeButton } from "../../../components/status/probe-button";
import { Tabs } from "../../../components/ui/tabs";
import { platform } from "../../../server/platform";
import { enabledModuleIds, webRegistry } from "../../../server/registry";
import { formatAgo, formatBytes, modelRows, troubleRows, workerLine } from "../../../server/status";
import { resolveViewer } from "../../../server/viewer";

export const metadata: Metadata = { title: "Status" };
export const dynamic = "force-dynamic";

const heading = "px-3 py-2 text-left text-xs font-medium text-muted";
const cell = "px-3 py-2 text-sm";

/** One tab's body: a titled section in the shell's card style. */
function Section({ id, title, note, children }: { id: string; title: string; note?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`${id}-heading`} className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-5">
      <div className="flex flex-col gap-1">
        <h2 id={`${id}-heading`} className="text-lg font-semibold tracking-tight">
          {title}
        </h2>
        {note === undefined ? null : <p className="max-w-2xl text-sm text-muted">{note}</p>}
      </div>
      {children}
    </section>
  );
}

const Empty = ({ children }: { children: ReactNode }) => <p className="text-sm text-muted">{children}</p>;

export default async function StatusPage() {
  const viewer = await resolveViewer(await headers());
  if (viewer === null) redirect("/login");

  if (!viewer.canWrite) {
    return (
      <div className="flex max-w-xl flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Status</h1>
        <p className="text-muted">Only an administrator can view the platform&apos;s status.</p>
      </div>
    );
  }

  const { pool } = platform();
  const registry = webRegistry();
  const now = new Date();
  const jobs = new JobService(pool, registry);
  const [counts, troubled, due, events, totals, enabled] = await Promise.all([
    jobs.counts(),
    jobs.troubled(20),
    jobs.dueWaiting(),
    new EventService(pool, registry).list({ limit: 50 }),
    new FileService(pool, registry, defaultFileStorage()).totals(),
    enabledModuleIds(pool),
  ]);
  const nameOf = (id: string) => registry.get(id)?.name ?? id;
  const waiting = workerLine(due);
  const trouble = troubleRows(troubled, now);
  const models = modelRows(registry.all(), enabled);

  return (
    <div className="flex max-w-5xl flex-col gap-10">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Status</h1>
        <p className="text-muted">What the platform is doing in the background. Reload the page to see it again.</p>
      </div>

      <Tabs
        label="Status"
        tabs={[
          {
            id: "jobs",
            label: "Jobs",
            content: (
              <Section id="jobs" title="Jobs" note="Work the worker process runs for the modules. A job that fails is tried again; one that runs out of attempts is dead.">
                {waiting === null ? null : (
                  <p role="note" className="max-w-2xl rounded-md bg-warning-soft px-3 py-2 text-sm">
                    {waiting}
                  </p>
                )}
                {counts.length === 0 ? (
                  <Empty>No module has queued a job yet.</Empty>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[32rem] text-left">
                      <caption className="sr-only">Jobs by module and status</caption>
                      <thead>
                        <tr className="border-b border-border">
                          <th scope="col" className={heading}>
                            Module
                          </th>
                          {JOB_STATUSES.map((status) => (
                            <th key={status} scope="col" className={`${heading} text-right capitalize`}>
                              {status}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {counts.map((entry) => (
                          <tr key={entry.moduleId}>
                            <th scope="row" className={`${cell} font-medium`}>
                              {nameOf(entry.moduleId)}
                            </th>
                            {JOB_STATUSES.map((status) => (
                              <td key={status} data-numeric className={`${cell} text-right tabular-nums ${status === "dead" && entry.counts.dead > 0 ? "font-medium text-danger" : ""}`}>
                                {entry.counts[status]}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <div className="flex flex-col gap-2">
                  <h3 className="text-sm font-semibold">Needs a look</h3>
                  {trouble.length === 0 ? (
                    <Empty>No job is dead or waiting for a retry.</Empty>
                  ) : (
                    <>
                      <div className="overflow-x-auto">
                        <table className="w-full min-w-[40rem] text-left">
                          <caption className="sr-only">Dead jobs and jobs waiting for a retry, newest first</caption>
                          <thead>
                            <tr className="border-b border-border">
                              {["Module", "Job", "State", "Attempts", "When", "What it reported"].map((title) => (
                                <th key={title} scope="col" className={heading}>
                                  {title}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border">
                            {trouble.map((row) => (
                              <tr key={row.id}>
                                <td className={cell}>{nameOf(row.moduleId)}</td>
                                <td className={`${cell} font-mono`}>{row.name}</td>
                                <td className={`${cell} ${row.state === "dead" ? "font-medium text-danger" : ""}`}>{row.state}</td>
                                <td className={`${cell} tabular-nums`}>{row.attempts}</td>
                                <td className={`${cell} whitespace-nowrap text-muted`}>{row.when}</td>
                                <td className={`${cell} max-w-sm break-words font-mono text-xs`}>{row.error ?? "nothing"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <p className="max-w-2xl text-xs text-muted">The last column is the message the job reported, cut to 200 characters. The data a job was given is never shown here.</p>
                    </>
                  )}
                </div>
              </Section>
            ),
          },
          {
            id: "events",
            label: "Events",
            content: (
              <Section id="events" title="Events" note="The newest 50 things modules announced. Events are kept for 7 days. What an event carries is not shown here.">
                {events.length === 0 ? (
                  <Empty>No event has been published in the last 7 days.</Empty>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[32rem] text-left">
                      <caption className="sr-only">The newest events</caption>
                      <thead>
                        <tr className="border-b border-border">
                          {["Id", "Module", "Type", "When"].map((title) => (
                            <th key={title} scope="col" className={heading}>
                              {title}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {events.map((event) => (
                          <tr key={event.id}>
                            <td data-numeric className={`${cell} tabular-nums text-muted`}>
                              {event.id}
                            </td>
                            <td className={cell}>{nameOf(event.moduleId)}</td>
                            <td className={`${cell} break-all font-mono text-xs`}>{event.type}</td>
                            <td className={`${cell} whitespace-nowrap text-muted`}>{formatAgo(event.createdAt, now)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Section>
            ),
          },
          {
            id: "files",
            label: "Files",
            content: (
              <Section id="files" title="Files" note="What modules have stored through the platform. Names and contents are not shown here.">
                {totals.length === 0 ? (
                  <Empty>No module has stored a file.</Empty>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[24rem] text-left">
                      <caption className="sr-only">Stored files by module</caption>
                      <thead>
                        <tr className="border-b border-border">
                          <th scope="col" className={heading}>
                            Module
                          </th>
                          <th scope="col" className={`${heading} text-right`}>
                            Files
                          </th>
                          <th scope="col" className={`${heading} text-right`}>
                            Total size
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {totals.map((entry) => (
                          <tr key={entry.moduleId}>
                            <th scope="row" className={`${cell} font-medium`}>
                              {nameOf(entry.moduleId)}
                            </th>
                            <td data-numeric className={`${cell} text-right tabular-nums`}>
                              {entry.files}
                            </td>
                            <td data-numeric className={`${cell} text-right tabular-nums`}>
                              {formatBytes(entry.bytes)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Section>
            ),
          },
          {
            id: "model",
            label: "Model",
            content: (
              <Section id="model" title="Model" note="The modules that call a language model. The endpoint, key and model are set in each module's settings; the test asks the provider for its list of models. The key is never shown.">
                {models.length === 0 ? (
                  <Empty>No enabled module calls a model.</Empty>
                ) : (
                  <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
                    {models.map((row) => (
                      <li key={row.id} className="flex flex-col gap-3 p-4">
                        <div className="flex flex-col gap-1">
                          <h3 className="font-medium">{row.name}</h3>
                          <p className="text-sm text-muted">
                            Endpoint from <code className="font-mono">{row.endpointSetting}</code>
                            {row.keySetting === null ? ", no key" : <>
                              , key from <code className="font-mono">{row.keySetting}</code>
                            </>}
                            {row.modelSetting === null ? "" : <>
                              , model from <code className="font-mono">{row.modelSetting}</code>
                            </>}
                            .
                          </p>
                        </div>
                        <ProbeButton moduleId={row.id} name={row.name} />
                      </li>
                    ))}
                  </ul>
                )}
              </Section>
            ),
          },
        ]}
      />
    </div>
  );
}
