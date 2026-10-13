import type { Metadata } from "next";
import { modules } from "../../../generated/modules";

export const metadata: Metadata = { title: "Apps" };

// The install and management screen is a later feature (A4); until then the CLI manages modules and this page
// shows what the running build was generated from.
export default function AppsPage() {
  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Apps</h1>
        <p className="text-muted">The modules this build was generated with.</p>
      </div>
      {modules.length === 0 ? (
        <p className="text-muted">No modules are enabled in this build.</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
          {modules.map((module) => (
            <li key={module.id} className="flex items-baseline justify-between gap-4 px-4 py-3">
              <span className="font-medium">{module.name}</span>
              <span className="text-sm text-muted" data-numeric>
                {module.id} · {module.version}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-sm text-muted">
        Install, enable, disable and uninstall from the server with <code className="font-mono text-foreground">npm run modules</code>, then run{" "}
        <code className="font-mono text-foreground">npm run web:build</code> and restart. Doing it from this screen is the next feature.
      </p>
    </div>
  );
}
