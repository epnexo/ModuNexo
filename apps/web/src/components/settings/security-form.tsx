"use client";

import { LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

export function SecurityForm({ initial, invalidStored, canWrite }: { initial: string[]; invalidStored: boolean; canWrite: boolean }) {
  const router = useRouter();
  const [text, setText] = useState(initial.join("\n"));
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setStatus(null);
    try {
      const response = await fetch("/api/settings/security", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ trustedProxies: text }),
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string; trustedProxies?: string[] };
      if (response.ok) {
        setText((data.trustedProxies ?? []).join("\n"));
        setStatus({ kind: "ok", text: "Saved." });
        router.refresh();
      } else {
        setStatus({ kind: "error", text: data.error ?? "Could not save the security settings." });
      }
    } catch {
      setStatus({ kind: "error", text: "Could not reach the server." });
    }
    setPending(false);
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-5">
      {invalidStored ? (
        <p role="alert" className="max-w-xl rounded-md bg-warning-soft px-3 py-2 text-sm">
          The stored list is not valid any more (a range may be too broad, or the value was edited by hand), so no proxy is trusted. Saving a new list
          replaces it.
        </p>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="trusted-proxies" className="text-sm font-medium">
          Trusted proxies
        </label>
        <textarea
          id="trusted-proxies"
          value={text}
          rows={4}
          disabled={!canWrite || pending}
          onChange={(event) => setText(event.target.value)}
          placeholder={"10.0.0.2\n192.168.1.0/24"}
          aria-describedby="trusted-proxies-help"
          className="max-w-md rounded-md border border-border-strong bg-surface px-3 py-2 font-mono text-sm outline-none transition-colors duration-150 focus-visible:border-accent disabled:opacity-60"
        />
        <p id="trusted-proxies-help" className="max-w-xl text-sm text-muted">
          One address or range per line. List the reverse proxies in front of this app that you control. When a request comes from one of them, the
          sign-in limit counts the client it reports instead of the proxy, so one person mistyping a password cannot lock everyone behind it. Leave it
          empty when nothing sits in front of the app.
        </p>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={!canWrite || pending}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-accent px-4 font-medium text-accent-foreground transition-colors duration-150 hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-70"
        >
          {pending ? <LoaderCircle aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : null}
          Save security settings
        </button>
        <p role="status" className={`text-sm ${status?.kind === "error" ? "text-danger" : "text-muted"}`}>
          {status?.text ?? ""}
        </p>
      </div>
    </form>
  );
}
