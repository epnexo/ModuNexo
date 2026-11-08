"use client";

import { Check, Copy, KeyRound, LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import type { AccessView, TokenView } from "../../server/api-access-view";

const INPUT = "h-10 rounded-md border border-border-strong bg-surface px-3 outline-none transition-colors duration-150 focus-visible:border-accent disabled:opacity-60";
const PRIMARY = "inline-flex h-10 items-center justify-center gap-2 rounded-md bg-accent px-4 font-medium text-accent-foreground transition-colors duration-150 hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-70";
const SECONDARY = "inline-flex h-9 items-center justify-center gap-2 rounded-md border border-border-strong px-3 text-sm font-medium transition-colors duration-150 hover:bg-panel-hover disabled:cursor-not-allowed disabled:opacity-60";
const EXPIRY = [
  { value: "", label: "Never expires" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
];
const SOURCE_NOTE = { saved: "Saved here.", "public-url": "From the WEB_PUBLIC_URL variable.", request: "Taken from this page's address. Save it to make it fixed.", none: "Not set." } as const;

const day = (iso: string | null) => (iso === null ? null : iso.slice(0, 10));

async function call(method: string, url: string, body?: unknown) {
  const response = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { ok: response.ok, data: (await response.json().catch(() => ({}))) as Record<string, any> };
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // The text is selectable by hand.
    }
  }
  return (
    <button type="button" onClick={copy} aria-label={`Copy ${label}`} className="shrink-0 rounded-md border border-border p-1.5 text-muted transition-colors duration-150 hover:text-foreground">
      {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
    </button>
  );
}

function StateBadge({ state }: { state: TokenView["state"] }) {
  const style = state === "active" ? "bg-accent-soft text-accent-soft-foreground" : state === "expired" ? "bg-warning-soft" : "bg-danger-soft text-danger";
  return <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${style}`}>{state === "active" ? "Active" : state === "expired" ? "Expired" : "Revoked"}</span>;
}

export function ApiAccess({ moduleId, name, view, canWrite }: { moduleId: string; name: string; view: AccessView; canWrite: boolean }) {
  const router = useRouter();
  const base = `/api/settings/modules/${encodeURIComponent(moduleId)}/tokens`;
  const first = view.tokens.length === 0;
  const [reveal, setReveal] = useState<{ title: string; token: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(view.address.source === "saved" ? (view.address.value ?? "") : "");
  const [tokenName, setTokenName] = useState(first ? "Default" : "");
  const [picked, setPicked] = useState<string[]>(first ? view.scopes.map((scope) => scope.key) : []);
  const [expiry, setExpiry] = useState("");
  const [confirm, setConfirm] = useState<{ kind: "regenerate" | "revoke"; id: number } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  async function run(key: string, work: () => Promise<void>) {
    setPending(key);
    setStatus(null);
    try {
      await work();
    } catch {
      setStatus({ kind: "error", text: "Could not reach the server." });
    }
    setPending(null);
  }

  const fail = (data: Record<string, any>, fallback: string) => setStatus({ kind: "error", text: typeof data.error === "string" ? data.error : fallback });

  const saveAddress = (value: string | null) =>
    run("address", async () => {
      const { ok, data } = await call("PUT", "/api/settings/api-address", { address: value });
      if (!ok) return fail(data, "Could not save the address.");
      setEditing(false);
      router.refresh();
    });

  const createToken = (event: FormEvent) => {
    event.preventDefault();
    return run("create", async () => {
      const { ok, data } = await call("POST", base, { name: tokenName, scopes: picked, ...(expiry === "" ? {} : { expiresInDays: Number(expiry) }) });
      if (!ok) return fail(data, "Could not create the token.");
      setReveal({ title: `Token “${tokenName.trim()}” created`, token: String(data.token) });
      setTokenName("");
      setPicked([]);
      router.refresh();
    });
  };

  const regenerate = (token: TokenView) =>
    run(`regenerate-${token.id}`, async () => {
      const { ok, data } = await call("POST", `${base}/${token.id}/regenerate`);
      setConfirm(null);
      if (!ok) return fail(data, "Could not regenerate the token.");
      setReveal({ title: `Token “${token.name}” regenerated. The previous one no longer works`, token: String(data.token) });
      router.refresh();
    });

  const revoke = (token: TokenView) =>
    run(`revoke-${token.id}`, async () => {
      const { ok, data } = await call("DELETE", `${base}/${token.id}`);
      setConfirm(null);
      if (!ok) return fail(data, "Could not revoke the token.");
      setStatus({ kind: "ok", text: `Token “${token.name}” revoked.` });
      router.refresh();
    });

  const toggle = (key: string) => setPicked((now) => (now.includes(key) ? now.filter((k) => k !== key) : [...now, key]));
  const heading = `api-access-${moduleId}`;

  return (
    <section aria-labelledby={heading} className="flex flex-col gap-6 rounded-lg border border-border bg-surface p-5">
      <div className="flex flex-col gap-1">
        <h2 id={heading} className="text-lg font-semibold tracking-tight">
          {name}: API access
        </h2>
        <p className="text-sm text-muted">How other computers and programs call this module. Give each one its own token, named after it, so you can tell who is calling.</p>
      </div>

      {reveal ? (
        <div role="status" className="flex flex-col gap-3 rounded-md border border-accent bg-accent-soft p-4 text-accent-soft-foreground">
          <p className="font-medium">{reveal.title}</p>
          <div className="flex items-start gap-2 rounded-md border border-border bg-background p-3 text-foreground">
            <code className="min-w-0 flex-1 select-all break-all font-mono text-xs leading-relaxed">{reveal.token}</code>
            <CopyButton text={reveal.token} label="the token" />
          </div>
          <p className="text-sm">Copy it now. It is shown only once; if you lose it, regenerate it.</p>
          <div>
            <button type="button" onClick={() => setReveal(null)} className={SECONDARY}>
              I copied it
            </button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Address</h3>
        {editing ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void saveAddress(draft.trim() === "" ? null : draft);
            }}
            className="flex flex-wrap items-center gap-2"
          >
            <input aria-label="Platform address" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="https://modunexo.example.com" className={`${INPUT} min-w-0 flex-1 font-mono text-sm`} />
            <button type="submit" disabled={!canWrite || pending === "address"} className={PRIMARY}>
              {pending === "address" ? <LoaderCircle aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : null}
              Save
            </button>
            <button type="button" onClick={() => setEditing(false)} className={SECONDARY}>
              Cancel
            </button>
          </form>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {view.address.value === null ? <span className="text-sm text-muted">Not set. Type it so the endpoints below show a full address.</span> : <code className="break-all font-mono text-sm">{view.address.value}</code>}
            {view.address.value === null ? null : <CopyButton text={view.address.value} label="the address" />}
            <button type="button" disabled={!canWrite} onClick={() => setEditing(true)} className={SECONDARY}>
              Change
            </button>
          </div>
        )}
        <p className="text-xs text-muted">
          {SOURCE_NOTE[view.address.source]} It is only what this page shows, the same for every module, and does not change how people sign in.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Endpoints</h3>
        {view.endpoints.length === 0 ? (
          <p className="text-sm text-muted">This module declares scopes but no routes for tokens yet.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
            {view.endpoints.map((endpoint) => (
              <li key={`${endpoint.method} ${endpoint.url}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                <span className="w-16 shrink-0 rounded-md border border-border px-1.5 py-0.5 text-center font-mono text-xs">{endpoint.method}</span>
                <code className="min-w-0 flex-1 break-all font-mono text-xs">{endpoint.url}</code>
                <span className="text-xs text-muted">{endpoint.scopeLabel}</span>
                <CopyButton text={endpoint.url} label={`${endpoint.method} ${endpoint.url}`} />
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted">Send the token as <code className="font-mono">Authorization: Bearer &lt;token&gt;</code>.</p>
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Tokens</h3>
        {view.tokens.length === 0 ? (
          <p className="text-sm text-muted">No tokens yet. Create the first one below.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
            {view.tokens.map((token) => {
              const asking = confirm?.id === token.id ? confirm.kind : null;
              return (
                <li key={token.id} className="flex flex-col gap-2 px-3 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <KeyRound size={14} aria-hidden className="text-muted" />
                    <span className="font-medium">{token.name}</span>
                    <StateBadge state={token.state} />
                    <code className="font-mono text-xs text-muted">mdnx_{token.prefix}…</code>
                  </div>
                  <p className="text-xs text-muted">
                    {token.scopes.join(", ")} · created {day(token.createdAt)} by {token.createdBy} · {token.lastUsedAt === null ? "never used" : `last used ${day(token.lastUsedAt)}`} ·{" "}
                    {token.expiresAt === null ? "never expires" : `${token.state === "expired" ? "expired" : "expires"} ${day(token.expiresAt)}`}
                  </p>
                  {token.state === "revoked" ? null : asking === null ? (
                    <div className="flex flex-wrap gap-2">
                      <button type="button" disabled={!canWrite} onClick={() => setConfirm({ kind: "regenerate", id: token.id })} className={SECONDARY}>
                        Regenerate
                      </button>
                      <button type="button" disabled={!canWrite} onClick={() => setConfirm({ kind: "revoke", id: token.id })} className={`${SECONDARY} text-danger`}>
                        Revoke
                      </button>
                    </div>
                  ) : (
                    <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md bg-warning-soft px-3 py-2 text-sm">
                      <span className="min-w-0 flex-1">
                        {asking === "regenerate" ? "The current token stops working at once and you get a new one. Anything using it must be updated." : "Anything using this token stops working at once. This cannot be undone."}
                      </span>
                      <button type="button" disabled={pending !== null} onClick={() => void (asking === "regenerate" ? regenerate(token) : revoke(token))} className={`${SECONDARY} ${asking === "revoke" ? "text-danger" : ""}`}>
                        {pending === `${asking}-${token.id}` ? <LoaderCircle aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : null}
                        {asking === "regenerate" ? "Regenerate" : "Revoke"}
                      </button>
                      <button type="button" onClick={() => setConfirm(null)} className={SECONDARY}>
                        Cancel
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <form onSubmit={createToken} className="flex flex-col gap-4">
        <h3 className="text-sm font-semibold">New token</h3>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${heading}-name`} className="text-sm font-medium">
            Name
          </label>
          <input id={`${heading}-name`} value={tokenName} onChange={(event) => setTokenName(event.target.value)} maxLength={80} placeholder="Ana's laptop" className={INPUT} />
          <p className="text-xs text-muted">The computer or person that will use it. It shows up here and in the audit trail.</p>
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">It can</legend>
          {view.scopes.map((scope) => (
            <label key={scope.key} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={picked.includes(scope.key)} onChange={() => toggle(scope.key)} />
              {scope.label} <code className="font-mono text-xs text-muted">{scope.key}</code>
            </label>
          ))}
        </fieldset>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${heading}-expiry`} className="text-sm font-medium">
            Lasts
          </label>
          <select id={`${heading}-expiry`} value={expiry} onChange={(event) => setExpiry(event.target.value)} className={INPUT}>
            {EXPIRY.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <button type="submit" disabled={!canWrite || pending === "create" || tokenName.trim() === "" || picked.length === 0} className={PRIMARY}>
            {pending === "create" ? <LoaderCircle aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : null}
            Create token
          </button>
        </div>
      </form>

      <p role="status" className={`min-h-5 text-sm ${status?.kind === "error" ? "text-danger" : "text-muted"}`}>
        {status?.text ?? ""}
      </p>
    </section>
  );
}
