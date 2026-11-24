"use client";

import { LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import type { TokenView } from "../../server/api-access-view";
import { mcpAddCommand } from "../../server/mcp-add-command";
import { CopyCommand } from "./copy-command";

const INPUT = "h-10 rounded-md border border-border-strong bg-surface px-3 outline-none transition-colors duration-150 focus-visible:border-accent disabled:opacity-60";
const PRIMARY = "inline-flex h-10 items-center justify-center gap-2 rounded-md bg-accent px-4 font-medium text-accent-foreground transition-colors duration-150 hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60";
const SECONDARY = "inline-flex h-9 items-center justify-center gap-2 rounded-md border border-border-strong px-3 text-sm font-medium transition-colors duration-150 hover:bg-panel-hover disabled:cursor-not-allowed disabled:opacity-60";
const EXPIRY = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days (recommended)" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
];

const day = (iso: string | null) => (iso === null ? null : iso.slice(0, 10));

async function call(method: string, url: string, body?: unknown) {
  const response = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { ok: response.ok, data: (await response.json().catch(() => ({}))) as Record<string, unknown> };
}

function StateBadge({ state }: { state: TokenView["state"] }) {
  const tone = state === "active" ? "badge-success" : state === "expired" ? "badge-warning" : "badge-danger";
  return <span className={`badge ${tone}`}>{state === "active" ? "Active" : state === "expired" ? "Expired" : "Revoked"}</span>;
}

/** What a key may do, from its scopes: read keys come from this screen, keys that can change the platform from the CLI. */
const access = (key: TokenView) => (key.scopes.includes("mcp.write") ? "Look and change" : "Look only");

/**
 * Remote access to the MCP endpoint: keys an administrator issues for another computer's Claude Code, shown once with the
 * command that connects it. Only read keys are issued here; a key that can change the platform is created with the CLI.
 */
export function McpRemote({ keys, address, note = null, canWrite }: { keys: TokenView[]; address: string | null; note?: string | null; canWrite: boolean }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState("30");
  const [reveal, setReveal] = useState<{ title: string; token: string } | null>(null);
  const [confirm, setConfirm] = useState<number | null>(null);
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

  const fail = (data: Record<string, unknown>, fallback: string) => setStatus({ kind: "error", text: typeof data.error === "string" ? data.error : fallback });

  const create = (event: FormEvent) => {
    event.preventDefault();
    return run("create", async () => {
      const { ok, data } = await call("POST", "/api/settings/mcp-keys", { name, expiresInDays: Number(expiry) });
      if (!ok) return fail(data, "Could not create the key.");
      setReveal({ title: `Key “${name.trim()}” created`, token: String(data.token) });
      setName("");
      router.refresh();
    });
  };

  const revoke = (key: TokenView) =>
    run(`revoke-${key.id}`, async () => {
      const { ok, data } = await call("DELETE", `/api/settings/mcp-keys/${key.id}`);
      setConfirm(null);
      if (!ok) return fail(data, "Could not revoke the key.");
      setStatus({ kind: "ok", text: `Key “${key.name}” revoked. It stops working at once.` });
      router.refresh();
    });

  const command = reveal === null ? null : mcpAddCommand(address, reveal.token);

  return (
    <section aria-labelledby="mcp-remote-heading" className="flex max-w-2xl flex-col gap-6 rounded-lg border border-border bg-surface p-5">
      <div className="flex flex-col gap-1">
        <h2 id="mcp-remote-heading" className="text-lg font-semibold tracking-tight">
          Remote access
        </h2>
        <p className="text-sm text-muted">
          Connect Claude Code on another computer over the network, with a key you can revoke. Give each computer its own key. Keys issued here can only look; a key that can also change the
          platform is created with <code className="font-mono text-xs">tokens create core --scope mcp.read --scope mcp.write</code>.
        </p>
      </div>

      {reveal ? (
        <div role="status" className="flex flex-col gap-3 rounded-md border border-accent bg-accent-soft p-4 text-accent-soft-foreground">
          <p className="font-medium">{reveal.title}</p>
          {command === null ? (
            <>
              <p className="text-sm">There is no address to point at yet, so here is the key alone. Set the address under a module&apos;s API access and add the key as <code className="font-mono">Authorization: Bearer &lt;key&gt;</code>.</p>
              <CopyCommand command={reveal.token} label="the key" />
            </>
          ) : (
            <>
              <p className="text-sm">Run this where Claude Code is. It contains the key, which is shown only once.</p>
              <CopyCommand command={command} label="the connect command" />
            </>
          )}
          <div>
            <button type="button" onClick={() => setReveal(null)} className={SECONDARY}>
              I copied it
            </button>
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Address</h3>
        {address === null ? (
          <p className="text-sm text-muted">Not set. Set it in the API access of any module; the same address is used here.</p>
        ) : (
          <code className="break-all font-mono text-sm">{address}/svc/core/mcp</code>
        )}
        {note === null ? null : <p className="notice notice-warning text-xs">{note}</p>}
        <p className="text-xs text-muted">Reachable from your local network only, unless you put it behind your own HTTPS proxy.</p>
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Keys</h3>
        {keys.length === 0 ? (
          <p className="text-sm text-muted">No keys yet. Create the first one below.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
            {keys.map((key) => (
              <li key={key.id} className="flex flex-col gap-1 px-3 py-2">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-medium">{key.name}</span>
                  <StateBadge state={key.state} />
                  <span className="text-xs text-muted">{access(key)}</span>
                  <code className="font-mono text-xs text-muted">mdnx_{key.prefix}…</code>
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
                  <span>Created {day(key.createdAt)}</span>
                  <span>{key.lastUsedAt === null ? "Never used" : `Last used ${day(key.lastUsedAt)}`}</span>
                  <span>{key.expiresAt === null ? "Never expires" : `Expires ${day(key.expiresAt)}`}</span>
                  {key.state === "active" && canWrite ? (
                    confirm === key.id ? (
                      <span className="flex items-center gap-2">
                        <button type="button" disabled={pending === `revoke-${key.id}`} onClick={() => void revoke(key)} className={SECONDARY}>
                          Revoke now
                        </button>
                        <button type="button" onClick={() => setConfirm(null)} className={SECONDARY}>
                          Keep
                        </button>
                      </span>
                    ) : (
                      <button type="button" onClick={() => setConfirm(key.id)} className={SECONDARY} aria-label={`Revoke ${key.name}`}>
                        Revoke
                      </button>
                    )
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {canWrite ? (
        <form onSubmit={create} className="flex flex-col gap-3" aria-label="Create a key">
          <h3 className="text-sm font-semibold">New key</h3>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex min-w-48 flex-1 flex-col gap-1 text-sm">
              Name
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Laptop of Ana" maxLength={100} required className={INPUT} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Expires in
              <select value={expiry} onChange={(event) => setExpiry(event.target.value)} className={INPUT}>
                {EXPIRY.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" disabled={pending === "create" || name.trim() === ""} className={PRIMARY}>
              {pending === "create" ? <LoaderCircle aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : null}
              Create key
            </button>
          </div>
        </form>
      ) : (
        <p className="text-sm text-muted">Only an administrator can create or revoke keys.</p>
      )}

      <div aria-live="polite">
        {status ? <p className={`text-sm ${status.kind === "error" ? "text-danger" : "text-success"}`}>{status.text}</p> : null}
      </div>
    </section>
  );
}
