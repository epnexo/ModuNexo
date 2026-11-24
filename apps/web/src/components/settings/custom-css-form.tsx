"use client";

import { LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

const MAX_BYTES = 16 * 1024;

/**
 * The company's custom CSS. The server checks the whole text and answers with the line of every problem, so what is shown
 * under the editor is exactly what it refused; nothing is stored until the whole stylesheet passes.
 */
export function CustomCssForm({ initial, canWrite, safeMode }: { initial: string; canWrite: boolean; safeMode: boolean }) {
  const router = useRouter();
  const [text, setText] = useState(initial);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const bytes = new TextEncoder().encode(text).length;

  async function send(method: "PUT" | "DELETE") {
    setPending(true);
    setStatus(null);
    try {
      const response = await fetch("/api/settings/appearance/custom-css", {
        method,
        headers: { "content-type": "application/json" },
        ...(method === "PUT" ? { body: JSON.stringify({ css: text }) } : {}),
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string; css?: string };
      if (response.ok) {
        if (method === "DELETE") setText("");
        setStatus({ kind: "ok", text: method === "DELETE" || text.trim() === "" ? "Removed." : "Saved." });
        router.refresh();
      } else {
        setStatus({ kind: "error", text: data.error ?? "Could not save the custom CSS." });
      }
    } catch {
      setStatus({ kind: "error", text: "Could not reach the server." });
    }
    setPending(false);
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void send("PUT");
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-4">
      {safeMode ? (
        <p role="note" className="notice notice-warning">
          Safe mode is on in this browser, so your custom CSS is not applied here. <a href="?nocss=0" className="underline">Turn it off</a>.
        </p>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="custom-css" className="text-sm font-medium">
          Stylesheet
        </label>
        <textarea
          id="custom-css"
          value={text}
          disabled={!canWrite || pending}
          onChange={(event) => setText(event.target.value)}
          spellCheck={false}
          rows={12}
          className="min-h-48 w-full rounded-md border border-border-strong bg-surface p-3 font-mono text-sm outline-none transition-colors duration-150 focus-visible:border-accent disabled:opacity-60"
          aria-describedby="custom-css-help custom-css-size"
          placeholder={'.card { border-color: var(--accent); }\n[data-module="ai-usage"] .au-card { padding: 1rem; }'}
        />
        <div className="flex flex-wrap justify-between gap-2 text-sm text-muted">
          <p id="custom-css-help">
            Set the platform&apos;s tokens on <code>:root</code>, or restyle a module&apos;s pages (<code>[data-module=&quot;id&quot;]</code>) or the platform&apos;s own
            classes (<code>.card</code>, <code>.badge</code>, <code>.btn</code>…) with colors, spacing, borders, text size and shadows. Nothing can be loaded, hidden or moved.
            If a page breaks, add <code>?nocss=1</code> to its address.
          </p>
          <p id="custom-css-size" data-numeric className={bytes > MAX_BYTES ? "text-danger" : undefined}>
            {bytes.toLocaleString("en-US")} / {MAX_BYTES.toLocaleString("en-US")} bytes
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={!canWrite || pending}
          className="btn btn-primary inline-flex h-10 items-center justify-center gap-2 disabled:cursor-not-allowed disabled:opacity-70"
        >
          {pending ? <LoaderCircle aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : null}
          Save custom CSS
        </button>
        <button type="button" disabled={!canWrite || pending || initial === ""} onClick={() => void send("DELETE")} className="btn inline-flex h-10 items-center justify-center disabled:cursor-not-allowed disabled:opacity-70">
          Remove
        </button>
        <p role="status" className={`text-sm ${status?.kind === "error" ? "text-danger" : "text-muted"}`}>
          {status?.kind === "error" ? null : (status?.text ?? (canWrite ? "" : "Only an administrator can change this."))}
        </p>
      </div>
      {status?.kind === "error" ? (
        <pre role="alert" className="notice notice-error whitespace-pre-wrap font-mono text-sm">
          {status.text}
        </pre>
      ) : null}
    </form>
  );
}
