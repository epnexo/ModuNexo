"use client";

import { LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

/** What the page knows about one declared setting. A secret's value is never part of it. */
export interface SettingView {
  key: string;
  label: string;
  type: "string" | "number" | "boolean" | "select" | "secret" | "path";
  description?: string;
  required: boolean;
  options?: string[];
  default?: string | number | boolean;
  effective: string | number | boolean | null;
  source: "stored" | "default" | "unset";
  secret?: { set: boolean; unreadable: boolean };
  incomplete: boolean;
  invalid: boolean;
}

export interface ModuleOverride {
  accentHue?: number;
  radius?: "sharp" | "default" | "round";
}

interface Props {
  moduleId: string;
  name: string;
  entries: SettingView[];
  override: ModuleOverride;
  platform: { accentHue: number; radius: "sharp" | "default" | "round" };
  canWrite: boolean;
}

type Fields = Record<string, string | boolean>;

/** What each input starts with. A default is shown as a placeholder, not as a value, so leaving it blank keeps the default. */
function initialFields(entries: SettingView[]): Fields {
  const fields: Fields = {};
  for (const entry of entries) {
    if (entry.type === "secret") fields[entry.key] = "";
    else if (entry.type === "boolean") fields[entry.key] = entry.effective === true;
    else fields[entry.key] = entry.source === "stored" && entry.effective !== null ? String(entry.effective) : "";
  }
  return fields;
}

const INPUT = "h-10 rounded-md border border-border-strong bg-surface px-3 outline-none transition-colors duration-150 focus-visible:border-accent disabled:opacity-60";

async function put(url: string, body: unknown) {
  const response = await fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { ok: response.ok, data: (await response.json().catch(() => ({}))) as Record<string, unknown> };
}

export function ModuleSettings({ moduleId, name, entries: initialEntries, override, platform, canWrite }: Props) {
  const router = useRouter();
  const [entries, setEntries] = useState(initialEntries);
  const [fields, setFields] = useState<Fields>(() => initialFields(initialEntries));
  const [clear, setClear] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const [hue, setHue] = useState<string>(override.accentHue === undefined ? "" : String(override.accentHue));
  const [radius, setRadius] = useState<string>(override.radius ?? "");
  const [appearancePending, setAppearancePending] = useState(false);
  const [appearanceStatus, setAppearanceStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setStatus(null);
    setErrors({});
    const initial = initialFields(entries);
    const values: Record<string, string | boolean> = {};
    for (const entry of entries) {
      const value = fields[entry.key]!;
      if (entry.type === "secret") {
        if (value !== "") values[entry.key] = value;
      } else if (value !== initial[entry.key]) {
        values[entry.key] = value;
      }
    }
    try {
      const { ok, data } = await put(`/api/settings/modules/${encodeURIComponent(moduleId)}`, { values, clear });
      if (ok) {
        const next = data.entries as SettingView[];
        setEntries(next);
        setFields(initialFields(next));
        setClear([]);
        setStatus({ kind: "ok", text: "Saved." });
        router.refresh();
      } else {
        setErrors((data.errors as Record<string, string> | undefined) ?? {});
        setStatus({ kind: "error", text: typeof data.error === "string" ? data.error : "Some values were refused; nothing was saved." });
      }
    } catch {
      setStatus({ kind: "error", text: "Could not reach the server." });
    }
    setPending(false);
  }

  async function saveAppearance(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAppearancePending(true);
    setAppearanceStatus(null);
    try {
      const { ok, data } = await put(`/api/settings/modules/${encodeURIComponent(moduleId)}/appearance`, {
        accentHue: hue === "" ? null : Number(hue),
        radius: radius === "" ? null : radius,
      });
      if (ok) {
        setAppearanceStatus({ kind: "ok", text: "Saved." });
        router.refresh();
      } else {
        setAppearanceStatus({ kind: "error", text: typeof data.error === "string" ? data.error : "Could not save." });
      }
    } catch {
      setAppearanceStatus({ kind: "error", text: "Could not reach the server." });
    }
    setAppearancePending(false);
  }

  const incomplete = entries.filter((entry) => entry.incomplete);

  return (
    <section aria-labelledby={`module-${moduleId}`} className="flex flex-col gap-6 rounded-lg border border-border bg-surface p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={`module-${moduleId}`} className="text-lg font-semibold tracking-tight">
          {name}
        </h2>
        {incomplete.length > 0 ? (
          <span className="rounded-md bg-warning-soft px-2 py-1 text-xs font-medium">
            {incomplete.length} required {incomplete.length === 1 ? "setting is" : "settings are"} not set
          </span>
        ) : null}
      </div>

      {entries.length > 0 ? (
        <form onSubmit={saveSettings} className="flex flex-col gap-5">
          {entries.map((entry) => {
            const id = `${moduleId}-${entry.key}`;
            const error = errors[entry.key];
            const described = [entry.description ? `${id}-help` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
            return (
              <div key={entry.key} className="flex flex-col gap-1.5">
                {entry.type === "boolean" ? (
                  <label className="flex items-center gap-2 text-sm font-medium">
                    <input
                      id={id}
                      type="checkbox"
                      checked={fields[entry.key] === true}
                      disabled={!canWrite || pending}
                      onChange={(event) => setFields({ ...fields, [entry.key]: event.target.checked })}
                      aria-describedby={described}
                      className="size-4 accent-(--accent)"
                    />
                    {entry.label}
                  </label>
                ) : (
                  <label htmlFor={id} className="text-sm font-medium">
                    {entry.label}
                    {entry.required ? <span className="ml-1 text-danger">*</span> : null}
                  </label>
                )}

                {entry.type === "select" ? (
                  <select
                    id={id}
                    value={String(fields[entry.key])}
                    disabled={!canWrite || pending}
                    onChange={(event) => setFields({ ...fields, [entry.key]: event.target.value })}
                    aria-describedby={described}
                    aria-invalid={error ? true : undefined}
                    className={`${INPUT} max-w-xs`}
                  >
                    <option value="">{entry.default !== undefined ? `Default (${entry.default})` : "Not set"}</option>
                    {(entry.options ?? []).map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                ) : entry.type === "secret" ? (
                  <div className="flex max-w-md flex-col gap-2">
                    <input
                      id={id}
                      type="password"
                      autoComplete="new-password"
                      value={String(fields[entry.key])}
                      disabled={!canWrite || pending || clear.includes(entry.key)}
                      onChange={(event) => setFields({ ...fields, [entry.key]: event.target.value })}
                      placeholder={entry.secret?.set ? (entry.secret.unreadable ? "Stored, but cannot be read: type a new value" : "Set. Type to replace it") : "Not set"}
                      aria-describedby={described}
                      aria-invalid={error ? true : undefined}
                      className={INPUT}
                    />
                    {entry.secret?.set ? (
                      <label className="flex items-center gap-2 text-sm text-muted">
                        <input
                          type="checkbox"
                          checked={clear.includes(entry.key)}
                          disabled={!canWrite || pending}
                          onChange={(event) => setClear(event.target.checked ? [...clear, entry.key] : clear.filter((key) => key !== entry.key))}
                          className="size-4 accent-(--accent)"
                        />
                        Remove the stored value
                      </label>
                    ) : null}
                  </div>
                ) : entry.type === "boolean" ? null : (
                  <input
                    id={id}
                    type="text"
                    inputMode={entry.type === "number" ? "decimal" : undefined}
                    value={String(fields[entry.key])}
                    disabled={!canWrite || pending}
                    onChange={(event) => setFields({ ...fields, [entry.key]: event.target.value })}
                    placeholder={entry.default !== undefined ? String(entry.default) : ""}
                    aria-describedby={described}
                    aria-invalid={error ? true : undefined}
                    className={`${INPUT} max-w-md ${entry.type === "path" ? "font-mono text-sm" : ""}`}
                  />
                )}

                {entry.description ? (
                  <p id={`${id}-help`} className="text-sm text-muted">
                    {entry.description}
                  </p>
                ) : null}
                {entry.invalid ? <p className="text-sm text-warning">The stored value is no longer accepted, so the default applies.</p> : null}
                {error ? (
                  <p id={`${id}-error`} className="text-sm text-danger">
                    {error}
                  </p>
                ) : null}
              </div>
            );
          })}
          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={!canWrite || pending}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-accent px-4 font-medium text-accent-foreground transition-colors duration-150 hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-70"
            >
              {pending ? <LoaderCircle aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : null}
              Save settings
            </button>
            <p role="status" className={`text-sm ${status?.kind === "error" ? "text-danger" : "text-muted"}`}>
              {status?.text ?? ""}
            </p>
          </div>
        </form>
      ) : (
        <p className="text-sm text-muted">This module declares no settings.</p>
      )}

      <form onSubmit={saveAppearance} className="flex flex-col gap-4 border-t border-border pt-5">
        <h3 className="text-sm font-semibold">Appearance of this module</h3>
        <div className="flex flex-wrap gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${moduleId}-hue`} className="text-sm font-medium">
              Accent hue
            </label>
            <input
              id={`${moduleId}-hue`}
              type="text"
              inputMode="decimal"
              value={hue}
              disabled={!canWrite || appearancePending}
              onChange={(event) => setHue(event.target.value)}
              placeholder={`Follow the platform (${platform.accentHue})`}
              className={`${INPUT} w-56`}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${moduleId}-radius`} className="text-sm font-medium">
              Corners
            </label>
            <select id={`${moduleId}-radius`} value={radius} disabled={!canWrite || appearancePending} onChange={(event) => setRadius(event.target.value)} className={`${INPUT} w-64`}>
              <option value="">Follow platform ({platform.radius})</option>
              <option value="sharp">Sharp</option>
              <option value="default">Default</option>
              <option value="round">Round</option>
            </select>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={!canWrite || appearancePending}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-border-strong px-4 font-medium transition-colors duration-150 hover:bg-panel-hover disabled:cursor-not-allowed disabled:opacity-70"
          >
            {appearancePending ? <LoaderCircle aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : null}
            Save appearance
          </button>
          <p role="status" className={`text-sm ${appearanceStatus?.kind === "error" ? "text-danger" : "text-muted"}`}>
            {appearanceStatus?.text ?? ""}
          </p>
        </div>
      </form>
    </section>
  );
}
