import Link from "next/link";
import type { McpActionsView } from "../../server/mcp-actions-view";

/**
 * What an agent can do in the modules, and how: a read answers at once, anything that changes data is only proposed and waits for
 * a person on the Actions screen. It describes; the switch for proposing stays where it was (the key and the write option).
 */
export function McpActions({ view }: { view: McpActionsView }) {
  return (
    <section aria-labelledby="mcp-actions-heading" className="flex max-w-2xl flex-col gap-4 rounded-lg border border-border bg-surface p-5">
      <div className="flex flex-col gap-1">
        <h2 id="mcp-actions-heading" className="text-lg font-semibold tracking-tight">
          What agents can do in your modules
        </h2>
        <p className="text-sm text-muted">
          Each module says what it lets an agent do. Reading answers at once. Anything that changes data is only proposed: it waits on the{" "}
          <Link href="/actions" className="underline">
            Actions screen
          </Link>{" "}
          until a person approves it, and an agent has no way to approve.
        </p>
      </div>

      <p className="text-sm" role="status" hidden={view.unavailable}>
        {view.waiting === 0 ? "Nothing is waiting for a decision." : `${view.waiting} proposal${view.waiting === 1 ? " is" : "s are"} waiting for a decision.`}{" "}
        <Link href="/actions" className="underline">
          Open the Actions screen
        </Link>
      </p>

      {view.unavailable ? (
        <p role="alert" data-guard className="notice notice-error text-sm">
          The actions could not be read right now. Try again in a moment.
        </p>
      ) : view.total === 0 ? (
        <p className="empty">No enabled module offers an action yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {view.modules.map((module) => (
            <li key={module.id} className="flex flex-col gap-1.5">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{module.name}</h3>
              <ul className="flex flex-col gap-1.5">
                {module.actions.map((action) => (
                  <li key={action.ref} className="flex flex-wrap items-baseline gap-2 text-sm">
                    <span className="font-medium">{action.label}</span>
                    <span className="font-mono text-xs text-muted">{action.ref}</span>
                    <span className={`badge ${action.risk === "read" ? "badge-info" : "badge-warning"}`}>{action.behaviour}</span>
                    <span className="w-full text-xs text-muted">{action.description}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}

      <details className="rounded-md border border-border p-3 text-sm">
        <summary className="cursor-pointer font-medium">How an agent uses them</summary>
        <ol className="mt-3 flex list-decimal flex-col gap-1.5 pl-5">
          <li>
            It lists them with <code className="font-mono text-xs">actions_list</code> and reads with <code className="font-mono text-xs">actions_run</code>, with any connection.
          </li>
          <li>
            To change something it calls <code className="font-mono text-xs">actions_propose</code>, which needs the connection with write tools. The proposal is recorded under the key&apos;s name.
          </li>
          <li>A person with the action&apos;s permission approves or rejects it here. Nothing runs before that, and a proposal nobody decides expires after seven days.</li>
        </ol>
      </details>
    </section>
  );
}
