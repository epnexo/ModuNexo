"use client";

import { FileArchive, LoaderCircle, Plus, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Tabs } from "../ui/tabs";
import { type RunRow, changeLabel, isFinished, planAction, runSummary } from "../../server/apps-flow";

interface Review {
  id: string;
  version: string;
  name: string;
  packageName: string;
  platform: string;
  pages: { path: string; public?: boolean; scope?: string }[];
  nav: { label: string }[];
  permissions: { key: string }[];
  jobs: { name: string; every?: string }[];
  events: { name: string; streamed: boolean }[];
  subscriptions: { event: string; job: string }[];
  files: { maxBytes: number; accept: string[] | null; downloadable: boolean } | null;
  settings: { key: string }[];
  migrations: string[];
  runsHooks: boolean;
  dependsOn: { id: string; range: string; status: string }[];
  dependencies: { name: string; range: string }[];
  scripts: string[];
}

interface PackageRow {
  id: number;
  sha256: string;
  moduleId: string | null;
  version: string | null;
  status: "staged" | "refused";
  problems: string[] | null;
  actor: string;
  receivedAt: string;
}

export interface AppsState {
  operations: RunRow[];
  packages: PackageRow[];
  running: RunRow | null;
}

type Staged = { sha256: string; sizeBytes: number; alreadyStaged: boolean; review: Review };

const when = (iso: string) => new Date(iso).toLocaleString();
const list = (values: string[]) => (values.length === 0 ? "none" : values.join(", "));
const formatBytes = (bytes: number): string => (bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} bytes`);

export interface InstalledModule {
  id: string;
  name: string;
  version: string;
  state: "enabled" | "disabled";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type Pending = { id: string; action: "enable" | "disable" | "uninstall"; mode?: "keep" | "purge" };

export function AppsManager({ initial, installed, modules }: { initial: AppsState; installed: Record<string, string>; modules: InstalledModule[] }) {
  const router = useRouter();
  const [state, setState] = useState<AppsState>(initial);
  const [tab, setTab] = useState<"apps" | "history">("apps");
  const [adding, setAdding] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [expected, setExpected] = useState("");
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [picking, setPicking] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [staged, setStaged] = useState<Staged | null>(null);
  const [problems, setProblems] = useState<string[] | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [starting, setStarting] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [typedId, setTypedId] = useState("");
  const wasRunning = useRef(initial.running !== null);
  // The apply process takes a moment to record its run, so after confirming the page watches for a while even
  // though nothing is "running" yet.
  const [watchUntil, setWatchUntil] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/apps", { cache: "no-store" });
      if (response.ok) setState((await response.json()) as AppsState);
    } catch {
      // The server restarts at the end of an install; the next poll finds it again.
    }
  }, []);

  const running = state.running;
  useEffect(() => {
    if (running !== null) wasRunning.current = true;
    else if (wasRunning.current) {
      wasRunning.current = false;
      void refresh();
      // The installed list and the versions come from the server render: reload them now that the run is over.
      router.refresh();
    }
    if (running === null && Date.now() >= watchUntil) return;
    const timer = setInterval(() => {
      void refresh();
      if (running === null && Date.now() >= watchUntil) clearInterval(timer);
    }, 2000);
    return () => clearInterval(timer);
  }, [running, refresh, watchUntil, router]);

  function send(body: File, headers: Record<string, string>): Promise<{ status: number; data: unknown }> {
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open("POST", "/api/apps/packages");
      for (const [name, value] of Object.entries(headers)) request.setRequestHeader(name, value);
      request.upload.onprogress = (event) => {
        if (event.lengthComputable) setProgress(Math.round((event.loaded / event.total) * 100));
      };
      request.onload = () => {
        let data: unknown = {};
        try {
          data = JSON.parse(request.responseText);
        } catch {
          data = {};
        }
        resolve({ status: request.status, data });
      };
      request.onerror = () => reject(new Error("network"));
      request.send(body);
    });
  }

  async function upload() {
    if (file === null) return;
    setUploading(true);
    setProgress(0);
    setMessage(null);
    setStaged(null);
    setProblems(null);
    try {
      const headers = { "content-type": "application/gzip", ...(expected.trim() === "" ? {} : { "x-expected-sha256": expected.trim().toLowerCase() }) };
      const response = await send(file, headers);
      const data = response.data as Partial<Staged> & { status?: string; error?: string; problems?: string[] };
      if (response.status >= 200 && response.status < 300 && data.status === "staged") setStaged(data as Staged);
      else if (response.status === 422 && data.problems) setProblems(data.problems);
      else setMessage({ kind: "error", text: data.error ?? "The package could not be uploaded." });
      void refresh();
    } catch {
      setMessage({ kind: "error", text: "Could not reach the server." });
    }
    setProgress(null);
    setUploading(false);
  }

  async function start(sha256: string) {
    setStarting(true);
    setMessage(null);
    try {
      const response = await fetch("/api/apps/operations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sha256, acknowledge: true }) });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (response.ok) {
        setStaged(null);
        setAcknowledged(false);
        setAdding(false);
        setFile(null);
        setExpected("");
        setWatchUntil(Date.now() + 60_000);
        setMessage({ kind: "ok", text: "Started. The web app is rebuilt and the server restarts at the end; this page keeps following the run." });
        await refresh();
      } else setMessage({ kind: "error", text: data.error ?? "Could not start the run." });
    } catch {
      setMessage({ kind: "error", text: "Could not reach the server." });
    }
    setStarting(false);
  }

  async function change(request: Pending) {
    setStarting(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/apps/modules/${encodeURIComponent(request.id)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request.action === "uninstall" ? { action: request.action, mode: request.mode } : { action: request.action }),
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (response.ok) {
        setPending(null);
        setTypedId("");
        setWatchUntil(Date.now() + 60_000);
        setMessage({ kind: "ok", text: "Started. The web app is rebuilt for the new state and the server restarts at the end." });
        await refresh();
      } else setMessage({ kind: "error", text: data.error ?? "Could not start the change." });
    } catch {
      setMessage({ kind: "error", text: "Could not reach the server." });
    }
    setStarting(false);
  }

  const action = staged === null ? null : planAction(staged.review, installed[staged.review.id]);
  const busy = running !== null;

  const appsContent = (
    <>
      <p role="status" className={`text-sm empty:hidden ${message?.kind === "error" ? "text-danger" : "text-muted"}`}>
        {message?.text ?? ""}
      </p>

      {adding && tab === "apps" ? (
      <section aria-labelledby="add-heading" className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-5">
        <div className="flex items-start justify-between gap-3">
          <h2 id="add-heading" className="text-lg font-semibold tracking-tight">
            Add an app manually
          </h2>
          <button
            type="button"
            onClick={() => {
              setAdding(false);
              setStaged(null);
              setProblems(null);
            }}
            disabled={uploading || starting}
            aria-label="Close"
            className="inline-flex size-9 items-center justify-center rounded-md text-muted transition-colors duration-150 hover:bg-panel-hover hover:text-foreground disabled:opacity-60"
          >
            <X aria-hidden className="size-5" />
          </button>
        </div>
        <p className="max-w-xl text-sm text-muted">
          Upload a module archive made with <code className="font-mono text-foreground">modules pack</code>. It is read as data and nothing is installed until you
          confirm. Installing runs the module&apos;s migrations and hooks with access to the database.
        </p>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="package-file" className="text-sm font-medium">
              Archive (.tgz)
            </label>
            <input
              ref={fileInput}
              id="package-file"
              type="file"
              accept=".tgz,.tar.gz,application/gzip"
              disabled={uploading || busy}
              className="sr-only"
              onChange={(event) => {
                setPicking(false);
                setFile(event.target.files?.[0] ?? null);
              }}
            />
            <div className="flex max-w-xl items-center gap-3 rounded-md border border-dashed border-border-strong bg-surface px-3 py-3" aria-live="polite">
              {picking ? <LoaderCircle aria-hidden className="size-5 shrink-0 animate-spin text-muted motion-reduce:animate-none" /> : <FileArchive aria-hidden className="size-5 shrink-0 text-muted" />}
              <div className="min-w-0 flex-1 text-sm">
                {picking ? (
                  <span className="text-muted">Waiting for the file dialog&hellip;</span>
                ) : file !== null ? (
                  <>
                    <span className="block truncate font-medium">{file.name}</span>
                    <span className="text-muted">{formatSize(file.size)}</span>
                  </>
                ) : (
                  <span className="text-muted">No file selected</span>
                )}
              </div>
              <button
                type="button"
                disabled={uploading || busy || picking}
                onClick={() => {
                  setPicking(true);
                  fileInput.current?.click();
                  window.addEventListener("focus", () => setTimeout(() => setPicking(false), 400), { once: true });
                }}
                className="h-9 shrink-0 rounded-md border border-border-strong px-3 text-sm transition-colors duration-150 hover:bg-panel-hover disabled:cursor-not-allowed disabled:opacity-60"
              >
                {file === null ? "Choose file" : "Change"}
              </button>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="package-sha" className="text-sm font-medium">
              SHA-256 from the publisher (optional)
            </label>
            <input
              id="package-sha"
              value={expected}
              disabled={uploading || busy}
              onChange={(event) => setExpected(event.target.value)}
              placeholder="64 hexadecimal characters"
              className="max-w-xl rounded-md border border-border-strong bg-surface px-3 py-2 font-mono text-sm outline-none transition-colors duration-150 focus-visible:border-accent disabled:opacity-60"
            />
          </div>
          <div>
            <button
              type="button"
              onClick={() => void upload()}
              disabled={file === null || uploading || busy}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-accent px-4 font-medium text-accent-foreground transition-colors duration-150 hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-70"
            >
              {uploading ? <LoaderCircle aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : null}
              {uploading ? (progress !== null && progress < 100 ? `Uploading ${progress}%` : "Reviewing package\u2026") : "Upload and review"}
            </button>
            {uploading ? (
              <div
                role="progressbar"
                aria-label="Upload progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progress !== null && progress < 100 ? progress : undefined}
                className="mt-3 h-1.5 max-w-xl overflow-hidden rounded-full bg-border-strong"
              >
                <div
                  className={`h-full rounded-full bg-accent transition-[width] duration-150 ${progress !== null && progress < 100 ? "" : "w-full animate-pulse motion-reduce:animate-none"}`}
                  style={progress !== null && progress < 100 ? { width: `${progress}%` } : undefined}
                />
              </div>
            ) : null}
          </div>
        </div>

        {problems !== null ? (
          <div role="alert" className="flex flex-col gap-2 rounded-md bg-danger-soft px-3 py-2 text-danger-soft-foreground">
            <p className="font-medium">This package was refused:</p>
            <ul className="list-disc pl-5 text-sm">
              {problems.map((problem) => (
                <li key={problem} className="break-words">
                  {problem}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {staged !== null && action !== null ? (
          <div className="flex flex-col gap-3 rounded-md border border-border p-4">
            <h3 className="text-base font-semibold">
              {staged.review.name} <span className="font-normal text-muted">{staged.review.id} · {staged.review.version}</span>
            </h3>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted">Package</dt>
              <dd>{staged.review.packageName}</dd>
              <dt className="text-muted">SHA-256</dt>
              <dd className="break-all font-mono text-xs">{staged.sha256}</dd>
              <dt className="text-muted">Platform</dt>
              <dd>{staged.review.platform}</dd>
              <dt className="text-muted">Pages</dt>
              <dd>{list(staged.review.pages.map((page) => page.path))}</dd>
              {staged.review.pages.some((page) => page.scope !== undefined) ? (
                <>
                  <dt className="text-muted">Token routes</dt>
                  <dd>
                    {list(staged.review.pages.filter((page) => page.scope !== undefined).map((page) => `${page.path} (${page.scope})`))}
                    <span className="block text-xs text-muted">These answer to a service token without a sign-in, guarded by the token and its scope.</span>
                  </dd>
                </>
              ) : null}
              {staged.review.pages.some((page) => page.public) ? (
                <>
                  <dt className="text-muted">Public routes</dt>
                  <dd>
                    {list(staged.review.pages.filter((page) => page.public).map((page) => page.path))}
                    <span className="block text-xs text-muted">These answer without a sign-in and are guarded only by their signature.</span>
                  </dd>
                </>
              ) : null}
              <dt className="text-muted">Navigation</dt>
              <dd>{list(staged.review.nav.map((item) => item.label))}</dd>
              {staged.review.jobs.length > 0 ? (
                <>
                  <dt className="text-muted">Background jobs</dt>
                  <dd>
                    {list(staged.review.jobs.map((job) => (job.every === undefined ? job.name : `${job.name} (every ${job.every})`)))}
                    <span className="block text-xs text-muted">These run in the worker process, with the platform&apos;s database access.</span>
                  </dd>
                </>
              ) : null}
              {staged.review.events.length > 0 ? (
                <>
                  <dt className="text-muted">Events</dt>
                  <dd>
                    {list(staged.review.events.map((event) => (event.streamed ? `${event.name} (streamed)` : event.name)))}
                    <span className="block text-xs text-muted">A streamed event is sent to signed-in browsers that hold its permission.</span>
                  </dd>
                </>
              ) : null}
              {staged.review.subscriptions.length > 0 ? (
                <>
                  <dt className="text-muted">Subscribes to</dt>
                  <dd>
                    {list(staged.review.subscriptions.map((subscription) => `${subscription.event} → ${subscription.job}`))}
                    <span className="block text-xs text-muted">The job runs in the worker process for every such event.</span>
                  </dd>
                </>
              ) : null}
              {staged.review.files !== null ? (
                <>
                  <dt className="text-muted">Stored files</dt>
                  <dd>
                    {`up to ${formatBytes(staged.review.files.maxBytes)} each; ${staged.review.files.accept === null ? "any type" : staged.review.files.accept.join(", ")}`}
                    <span className="block text-xs text-muted">
                      {staged.review.files.downloadable ? "Signed-in browsers that hold its permission can download them." : "No browser can download them."}
                    </span>
                  </dd>
                </>
              ) : null}
              <dt className="text-muted">Permissions</dt>
              <dd>{list(staged.review.permissions.map((permission) => permission.key))}</dd>
              <dt className="text-muted">Settings</dt>
              <dd>{list(staged.review.settings.map((setting) => setting.key))}</dd>
              <dt className="text-muted">Migrations</dt>
              <dd>{list(staged.review.migrations)}</dd>
              <dt className="text-muted">Hooks</dt>
              <dd>{staged.review.runsHooks ? "Yes: the package's own code runs inside the platform when it is installed." : "None"}</dd>
              <dt className="text-muted">Depends on</dt>
              <dd>{list(staged.review.dependsOn.map((need) => `${need.id} ${need.range} (${need.status})`))}</dd>
              <dt className="text-muted">Libraries</dt>
              <dd>{list(staged.review.dependencies.map((dependency) => `${dependency.name} ${dependency.range}`))}</dd>
              <dt className="text-muted">Scripts</dt>
              <dd>{staged.review.scripts.length === 0 ? "None (scripts are never run)" : `${staged.review.scripts.join(", ")} (never run)`}</dd>
            </dl>
            {action.blocked !== null ? (
              <p role="alert" className="rounded-md bg-warning-soft px-3 py-2 text-sm">
                {action.blocked}
              </p>
            ) : null}
            <label className="flex max-w-xl items-start gap-2 text-sm">
              <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} className="mt-1 size-4 accent-[var(--accent)]" />
              <span>
                I trust the source of this package. It runs with full access to the platform and its database, and a package from an unknown source can read or change everything stored here.
              </span>
            </label>
            <div>
              <button
                type="button"
                onClick={() => void start(staged.sha256)}
                disabled={action.blocked !== null || starting || busy || !acknowledged}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-accent px-4 font-medium text-accent-foreground transition-colors duration-150 hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-70"
              >
                {starting ? <LoaderCircle aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : null}
                {action.label}
              </button>
            </div>
          </div>
        ) : null}

      </section>
      ) : null}

      <section className="flex flex-col gap-3">
        <h2 className="sr-only">Installed apps</h2>
        {modules.length === 0 ? (
          <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed border-border-strong p-6">
            <p className="text-sm text-muted">No app is installed yet.</p>
            <button type="button" onClick={() => setAdding(true)} disabled={adding} className="h-9 rounded-md border border-border-strong px-3 text-sm hover:bg-panel-hover disabled:opacity-60">
              Add your first app
            </button>
          </div>
        ) : null}
        <ul className="divide-y divide-border rounded-lg border border-border bg-surface px-4">
          {modules.map((module) => {
            const open = pending !== null && pending.id === module.id;
            return (
              <li key={module.id} className="flex flex-col gap-3 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <span className="font-medium">
                    {module.name} <span className="font-normal text-muted" data-numeric>{module.id} · {module.version}</span>
                  </span>
                  <span className="text-sm text-muted">{module.state === "enabled" ? "Enabled" : "Disabled"}</span>
                </div>
                {!open ? (
                  <div className="flex flex-wrap gap-2">
                    {module.state === "enabled" ? (
                      <button type="button" disabled={busy || starting} onClick={() => setPending({ id: module.id, action: "disable" })} className="h-9 rounded-md border border-border-strong px-3 text-sm transition-colors duration-150 hover:bg-panel-hover disabled:cursor-not-allowed disabled:opacity-60">
                        Disable
                      </button>
                    ) : (
                      <button type="button" disabled={busy || starting} onClick={() => setPending({ id: module.id, action: "enable" })} className="h-9 rounded-md border border-border-strong px-3 text-sm transition-colors duration-150 hover:bg-panel-hover disabled:cursor-not-allowed disabled:opacity-60">
                        Enable
                      </button>
                    )}
                    <button type="button" disabled={busy || starting} onClick={() => setPending({ id: module.id, action: "uninstall" })} className="h-9 rounded-md border border-border-strong px-3 text-sm text-danger transition-colors duration-150 hover:bg-panel-hover disabled:cursor-not-allowed disabled:opacity-60">
                      Uninstall…
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-col gap-3 rounded-md border border-border p-3">
                    {pending.action === "uninstall" ? (
                      <fieldset className="flex flex-col gap-2">
                        <legend className="text-sm font-medium">What happens to {module.name}&apos;s data?</legend>
                        <label className="flex items-start gap-2 text-sm">
                          <input type="radio" name={`mode-${module.id}`} checked={pending.mode === "keep"} onChange={() => setPending({ ...pending, mode: "keep" })} />
                          <span>Keep it. The schema and its migration history stay, so installing the module again finds its data.</span>
                        </label>
                        <label className="flex items-start gap-2 text-sm">
                          <input type="radio" name={`mode-${module.id}`} checked={pending.mode === "purge"} onChange={() => setPending({ ...pending, mode: "purge" })} />
                          <span>Delete it. The module&apos;s schema and migration history are dropped. This cannot be undone.</span>
                        </label>
                        {pending.mode === "purge" ? (
                          <div className="flex flex-col gap-1.5">
                            <label htmlFor={`confirm-${module.id}`} className="text-sm">
                              Type <code className="font-mono">{module.id}</code> to confirm
                            </label>
                            <input
                              id={`confirm-${module.id}`}
                              value={typedId}
                              onChange={(event) => setTypedId(event.target.value)}
                              autoComplete="off"
                              className="max-w-xs rounded-md border border-border-strong bg-surface px-3 py-2 font-mono text-sm outline-none focus-visible:border-accent"
                            />
                          </div>
                        ) : null}
                      </fieldset>
                    ) : (
                      <p className="text-sm">
                        {pending.action === "disable"
                          ? `Disable ${module.name}? Its pages leave the app; its data is kept.`
                          : `Enable ${module.name}? Its pages come back after the web app is rebuilt.`}
                      </p>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={starting || busy || (pending.action === "uninstall" && (pending.mode === undefined || (pending.mode === "purge" && typedId !== module.id)))}
                        onClick={() => void change(pending)}
                        className="inline-flex h-9 items-center gap-2 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground transition-colors duration-150 hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {starting ? <LoaderCircle aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : null}
                        {changeLabel(pending.action, pending.mode)}
                      </button>
                      <button
                        type="button"
                        disabled={starting}
                        onClick={() => {
                          setPending(null);
                          setTypedId("");
                        }}
                        className="h-9 rounded-md border border-border-strong px-3 text-sm transition-colors duration-150 hover:bg-panel-hover"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );

  const historyContent = (
    <>
      <section className="flex flex-col gap-3">
        <h2 className="sr-only">History</h2>
        {state.operations.length === 0 && state.packages.length === 0 ? <p className="text-sm text-muted">Nothing has been added or installed from here yet.</p> : null}
        {state.operations.length > 0 ? (
          <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
            {state.operations.map((run) => (
              <li key={`run-${run.id}`} className="flex flex-col gap-0.5 px-4 py-3">
                <span className="text-sm">{runSummary(run)}</span>
                <span className="text-xs text-muted" data-numeric>
                  {when(run.startedAt)} · {run.actor}
                  {isFinished(run) ? "" : " · running"}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {state.packages.length > 0 ? (
          <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
            {state.packages.map((pkg) => (
              <li key={`pkg-${pkg.id}`} className="flex flex-col gap-0.5 px-4 py-3">
                <span className="text-sm">
                  {pkg.status === "staged" ? "Received" : "Refused"} {pkg.moduleId ?? "a package"} {pkg.version ?? ""}
                </span>
                <span className="break-all font-mono text-xs text-muted">{pkg.sha256}</span>
                <span className="text-xs text-muted" data-numeric>
                  {when(pkg.receivedAt)} · {pkg.actor}
                </span>
                {pkg.problems !== null ? <span className="text-xs text-danger">{pkg.problems.join("; ")}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </>
  );

  return (
    <div className="flex flex-col gap-8">
      {running !== null ? (
        <section aria-labelledby="run-heading" className="flex flex-col gap-2 rounded-lg border border-border bg-accent-soft p-4 text-accent-soft-foreground">
          <h2 id="run-heading" className="flex items-center gap-2 text-base font-semibold">
            <LoaderCircle aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
            Run in progress
          </h2>
          <p role="status">{runSummary(running)}</p>
          <p className="text-sm">Started {when(running.startedAt)} by {running.actor}. A build takes a few minutes on this machine.</p>
        </section>
      ) : null}

      <Tabs
        label="Apps"
        value={tab}
        onValueChange={(id) => setTab(id as "apps" | "history")}
        actions={
          <button
            type="button"
            onClick={() => {
              setTab("apps");
              setAdding(true);
            }}
            disabled={adding}
            className="inline-flex h-9 items-center gap-2 rounded-md bg-accent px-3 text-sm font-medium text-accent-foreground transition-colors duration-150 hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Plus aria-hidden className="size-4" />
            Add app
          </button>
        }
        tabs={[
          { id: "apps", label: "Apps", content: appsContent },
          { id: "history", label: "History", content: historyContent },
        ]}
      />
    </div>
  );
}
