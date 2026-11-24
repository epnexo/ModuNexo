"use client";

import { LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import type { RunnableView } from "../../server/actions-view";

type Values = Record<string, string | boolean>;

/** The form of one action, made from the inputs it declares. A read shows its rows here; a write runs as the person pressing the button. */
export function RunActionForm({ action }: { action: RunnableView }) {
  const router = useRouter();
  const [values, setValues] = useState<Values>({});
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null);

  function input(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const spec of action.inputs) {
      const value = values[spec.name];
      if (value === undefined || value === "") continue;
      out[spec.name] = spec.type === "int" ? Number(value) : value;
    }
    return out;
  }

  async function run(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setResult(null);
    setRows(null);
    try {
      const response = await fetch("/api/actions/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: action.ref, input: input() }) });
      const data = (await response.json().catch(() => ({}))) as { error?: string; kind?: string; rows?: Record<string, unknown>[]; jobId?: number };
      if (!response.ok) setResult({ kind: "error", text: data.error ?? "Could not run it." });
      else if (data.kind === "rows") {
        setRows(data.rows ?? []);
        setResult({ kind: "ok", text: `${(data.rows ?? []).length} row(s).` });
      } else {
        setResult({ kind: "ok", text: `Queued as job ${data.jobId}. It runs now, as you.` });
        router.refresh();
      }
    } catch {
      setResult({ kind: "error", text: "Could not reach the server." });
    }
    setPending(false);
  }

  return (
    <form onSubmit={run} className="card flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="section-title m-0">{action.label}</h3>
        <span className={`badge ${action.risk === "read" ? "badge-info" : "badge-warning"}`}>{action.risk}</span>
        <span className="text-sm text-muted">{action.moduleName}</span>
      </div>
      <p className="text-sm text-muted">{action.description}</p>
      <div className="flex flex-wrap items-end gap-3">
        {action.inputs.map((spec) => (
          <div key={spec.name} className="flex flex-col gap-1">
            <label htmlFor={`${action.ref}-${spec.name}`} className="text-sm font-medium">
              {spec.name}
              {spec.required ? " *" : ""}
            </label>
            {spec.type === "boolean" ? (
              <input id={`${action.ref}-${spec.name}`} type="checkbox" checked={values[spec.name] === true} onChange={(event) => setValues({ ...values, [spec.name]: event.target.checked })} />
            ) : spec.type === "enum" ? (
              <select id={`${action.ref}-${spec.name}`} className="input h-9" required={spec.required} value={String(values[spec.name] ?? "")} onChange={(event) => setValues({ ...values, [spec.name]: event.target.value })}>
                <option value="">Choose…</option>
                {spec.values?.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={`${action.ref}-${spec.name}`}
                className="input h-9 w-56"
                type={spec.type === "int" ? "number" : "text"}
                required={spec.required}
                {...(spec.type === "int" ? { min: spec.min, max: spec.max } : { maxLength: spec.maxLength })}
                placeholder={spec.description}
                value={String(values[spec.name] ?? "")}
                onChange={(event) => setValues({ ...values, [spec.name]: event.target.value })}
              />
            )}
          </div>
        ))}
        <button type="submit" disabled={pending} className="btn btn-primary inline-flex h-9 items-center gap-2">
          {pending ? <LoaderCircle aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : null}
          {action.risk === "read" ? "Run" : "Run now"}
        </button>
      </div>
      {result === null ? null : (
        <p role="status" className={`text-sm ${result.kind === "error" ? "text-danger" : "text-muted"}`}>
          {result.text}
        </p>
      )}
      {rows === null || rows.length === 0 ? null : <pre className="max-h-64 overflow-auto rounded-md border border-border bg-panel p-3 text-xs">{JSON.stringify(rows, null, 2)}</pre>}
    </form>
  );
}
