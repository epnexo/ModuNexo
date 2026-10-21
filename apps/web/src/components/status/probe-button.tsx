"use client";

import { LoaderCircle } from "lucide-react";
import { useState } from "react";

type Outcome = { ok: true; lines: string[] } | { ok: false; code: string; error: string };

/** Tests one module's model connection and shows what the provider answered, or why it did not. The key is never shown. */
export function ProbeButton({ moduleId, name }: { moduleId: string; name: string }) {
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  async function test() {
    setPending(true);
    setOutcome(null);
    try {
      const response = await fetch(`/api/status/llm/${encodeURIComponent(moduleId)}`, { method: "POST" });
      const data = (await response.json().catch(() => ({}))) as { lines?: string[]; error?: string; code?: string };
      setOutcome(response.ok && data.lines !== undefined ? { ok: true, lines: data.lines } : { ok: false, code: data.code ?? "unknown", error: data.error ?? "The test did not answer." });
    } catch {
      setOutcome({ ok: false, code: "unreachable", error: "Could not reach the server." });
    }
    setPending(false);
  }

  return (
    <div className="flex flex-col gap-2">
      <div>
        <button
          type="button"
          onClick={test}
          disabled={pending}
          aria-label={`Test the model connection of ${name}`}
          className="inline-flex h-9 items-center gap-2 rounded-md border border-border-strong px-3 text-sm transition-colors duration-150 hover:bg-panel-hover disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? <LoaderCircle aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : null}
          Test connection
        </button>
      </div>
      <div role="status" aria-live="polite" className="empty:hidden">
        {outcome === null ? null : outcome.ok ? (
          <ul className="flex flex-col gap-0.5 text-sm text-muted">
            {outcome.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : (
          <p className="max-w-xl rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-soft-foreground">
            <span className="font-mono">{outcome.code}</span>: {outcome.error}
          </p>
        )}
      </div>
    </div>
  );
}
