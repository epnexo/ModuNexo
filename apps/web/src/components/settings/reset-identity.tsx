"use client";

import { LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

/** The only way to change the kind of the platform: typing the current name back, then starting the setup again. */
export function ResetIdentity({ name }: { name: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/settings/brand", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: typed }) });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (response.ok) {
        router.replace("/setup");
        router.refresh();
        return;
      }
      setError(data.error ?? "The identity could not be reset.");
    } catch {
      setError("Could not reach the server.");
    }
    setPending(false);
  }

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-5">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold text-danger">Reset identity</h3>
        <p className="max-w-xl text-sm text-muted">Removes the profile and the logo and runs the setup again, so you can choose business or person anew. Your CRM data is not touched.</p>
      </div>
      {open ? (
        <form onSubmit={reset} className="flex max-w-xl flex-col gap-3">
          <label htmlFor="reset-name" className="text-sm font-medium">
            Type <span className="font-mono">{name}</span> to confirm
          </label>
          <input id="reset-name" value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" disabled={pending} className="h-10 rounded-md border border-border-strong bg-surface px-3 outline-none focus-visible:border-danger disabled:opacity-60" />
          <div className="flex items-center gap-3">
            <button type="submit" disabled={pending || typed.trim() !== name} className="inline-flex h-10 items-center gap-2 rounded-md bg-danger px-4 font-medium text-white transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-60">
              {pending ? <LoaderCircle aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : null}
              Reset identity
            </button>
            <button type="button" disabled={pending} onClick={() => { setOpen(false); setTyped(""); setError(null); }} className="h-10 rounded-md border border-border-strong px-4 text-sm hover:bg-panel-hover">
              Cancel
            </button>
            <p role="alert" className="text-sm text-danger">{error}</p>
          </div>
        </form>
      ) : (
        <div>
          <button type="button" onClick={() => setOpen(true)} className="h-9 rounded-md border border-border-strong px-3 text-sm text-danger transition-colors duration-150 hover:bg-panel-hover">
            Reset identity&hellip;
          </button>
        </div>
      )}
    </div>
  );
}
