"use client";

import { ArrowDown, ArrowUp, LoaderCircle, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

export interface GroupItem {
  id: number;
  name: string;
  moduleCount: number;
}

export interface ModuleItem {
  id: string;
  name: string;
  groupId: number | null;
}

const field = "h-10 rounded-md border border-border-strong bg-surface px-3 text-sm outline-none transition-colors duration-150 focus-visible:border-accent disabled:opacity-60";
const button =
  "inline-flex h-10 items-center justify-center gap-2 rounded-md border border-border-strong px-3 text-sm font-medium transition-colors duration-150 hover:bg-panel disabled:cursor-not-allowed disabled:opacity-60";

/** The menu groups an administrator manages, and the group each installed module sits in. Every change is a call to `/api/groups` followed by a refresh. */
export function GroupsManager({ groups, modules }: { groups: GroupItem[]; modules: ModuleItem[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  async function call(path: string, method: string, body?: unknown): Promise<boolean> {
    setBusy(true);
    setStatus(null);
    try {
      const response = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setStatus({ kind: "error", text: data.error ?? "That did not work." });
        return false;
      }
      router.refresh();
      return true;
    } catch {
      setStatus({ kind: "error", text: "Could not reach the server." });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await call("/api/groups", "POST", { name })) setName("");
  }

  return (
    <div className="flex flex-col gap-8">
      {status === null ? null : (
        <p role={status.kind === "error" ? "alert" : "status"} className={`max-w-xl rounded-md px-3 py-2 text-sm ${status.kind === "error" ? "bg-danger-soft text-danger-soft-foreground" : "bg-success-soft"}`}>
          {status.text}
        </p>
      )}

      <section aria-labelledby="groups-heading" className="flex flex-col gap-3">
        <h2 id="groups-heading" className="text-lg font-semibold tracking-tight">
          Groups
        </h2>
        <form onSubmit={create} className="flex max-w-xl items-end gap-2">
          <div className="flex flex-1 flex-col gap-1.5">
            <label htmlFor="new-group" className="text-sm font-medium">
              New group
            </label>
            <input id="new-group" value={name} maxLength={40} disabled={busy} onChange={(event) => setName(event.target.value)} placeholder="Sales" className={field} />
          </div>
          <button type="submit" disabled={busy || name.trim() === ""} className={`${button} bg-accent text-accent-foreground hover:bg-accent-hover`}>
            {busy ? <LoaderCircle aria-hidden className="size-4 animate-spin" /> : null}
            Add
          </button>
        </form>
        {groups.length === 0 ? (
          <p className="text-sm text-muted">No groups yet. Without groups, each module sits under the group its own manifest names, if any.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface">
            {groups.map((group, index) => (
              <GroupRow key={`${group.id}:${group.name}`} group={group} index={index} last={index === groups.length - 1} busy={busy} call={call} />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="modules-heading" className="flex flex-col gap-3">
        <h2 id="modules-heading" className="text-lg font-semibold tracking-tight">
          Modules
        </h2>
        {modules.length === 0 ? (
          <p className="text-sm text-muted">No modules are installed yet.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface">
            {modules.map((module) => (
              <li key={module.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                <label htmlFor={`group-of-${module.id}`} className="min-w-0 flex-1 font-medium">
                  {module.name}
                </label>
                <select
                  id={`group-of-${module.id}`}
                  value={module.groupId ?? ""}
                  disabled={busy}
                  onChange={(event) => call("/api/groups/assign", "POST", { moduleId: module.id, groupId: event.target.value === "" ? null : Number(event.target.value) })}
                  className={field}
                >
                  <option value="">No group</option>
                  {groups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function GroupRow({ group, index, last, busy, call }: { group: GroupItem; index: number; last: boolean; busy: boolean; call: (path: string, method: string, body?: unknown) => Promise<boolean> }) {
  const [name, setName] = useState(group.name);
  const moveTo = (position: number) => call(`/api/groups/${group.id}`, "PATCH", { position });
  return (
    <li className="flex flex-wrap items-center gap-2 px-4 py-3">
      <label htmlFor={`name-${group.id}`} className="sr-only">
        Name of the group {group.name}
      </label>
      <input
        id={`name-${group.id}`}
        value={name}
        maxLength={40}
        disabled={busy}
        onChange={(event) => setName(event.target.value)}
        onBlur={() => {
          if (name.trim() !== group.name) void call(`/api/groups/${group.id}`, "PATCH", { name });
        }}
        className={`${field} min-w-0 flex-1`}
      />
      <span className="text-sm text-muted">{group.moduleCount === 1 ? "1 module" : `${group.moduleCount} modules`}</span>
      <button type="button" disabled={busy || index === 0} aria-label={`Move the group ${group.name} up`} onClick={() => moveTo(index - 1)} className={button}>
        <ArrowUp aria-hidden className="size-4" />
      </button>
      <button type="button" disabled={busy || last} aria-label={`Move the group ${group.name} down`} onClick={() => moveTo(index + 1)} className={button}>
        <ArrowDown aria-hidden className="size-4" />
      </button>
      <button
        type="button"
        disabled={busy}
        aria-label={`Delete the group ${group.name}`}
        onClick={() => {
          if (window.confirm(group.moduleCount === 0 ? `Delete the group "${group.name}"?` : `Delete the group "${group.name}"? Its ${group.moduleCount} module(s) stay installed and have no group.`)) void call(`/api/groups/${group.id}`, "DELETE");
        }}
        className={button}
      >
        <Trash2 aria-hidden className="size-4" />
      </button>
    </li>
  );
}
