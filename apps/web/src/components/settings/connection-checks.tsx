"use client";

import { LoaderCircle } from "lucide-react";
import { useState } from "react";
import { type CheckOutcome, type CheckView, readCheckAnswer } from "../../server/connection-checks";

const SECONDARY = "inline-flex h-9 items-center justify-center gap-2 rounded-md border border-border-strong px-3 text-sm font-medium transition-colors duration-150 hover:bg-panel-hover disabled:cursor-not-allowed disabled:opacity-60";

/** Posts to the module's route, from this site and with the session, and reads what it answers. Nothing is sent in the body. */
async function run(path: string): Promise<CheckOutcome> {
  try {
    const response = await fetch(path, { method: "POST", credentials: "same-origin" });
    return readCheckAnswer(response.status, await response.json().catch(() => null));
  } catch {
    return { ok: false, message: "Could not reach the server." };
  }
}

function Check({ check, canWrite }: { check: CheckView; canWrite: boolean }) {
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<CheckOutcome | null>(null);
  const id = `check-${check.key}`;

  async function press() {
    setPending(true);
    setOutcome(null);
    setOutcome(await run(check.path));
    setPending(false);
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={press} disabled={!canWrite || pending} aria-describedby={check.description ? `${id}-help` : undefined} className={SECONDARY}>
          {pending ? <LoaderCircle aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : null}
          {check.label}
        </button>
        <p role="status" className={`text-sm ${outcome === null ? "text-muted" : outcome.ok ? "text-success" : "text-danger"}`}>
          {outcome?.message ?? ""}
        </p>
      </div>
      {check.description ? (
        <p id={`${id}-help`} className="text-sm text-muted">
          {check.description}
        </p>
      ) : null}
    </div>
  );
}

/** The connection checks a module declares: a button each, under its settings. They run with the settings already saved. */
export function ConnectionChecks({ moduleId, name, checks, canWrite }: { moduleId: string; name: string; checks: CheckView[]; canWrite: boolean }) {
  const heading = `${moduleId}-checks-heading`;
  return (
    <section aria-labelledby={heading} className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-5">
      <div className="flex flex-col gap-1">
        <h2 id={heading} className="text-lg font-semibold tracking-tight">
          Connection checks
        </h2>
        <p className="text-sm text-muted">Test what {name} is set up to reach. A check uses the settings already saved, so save any change first.</p>
      </div>
      {checks.map((check) => (
        <Check key={check.key} check={check} canWrite={canWrite} />
      ))}
    </section>
  );
}
