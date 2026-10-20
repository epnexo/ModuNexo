import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type pg from "pg";
import type { JobHandler, ModuleManifest } from "@modunexo/sdk";
import { discoverModules } from "../discovery.ts";
import { EventService } from "../events/index.ts";
import { JobService, type JobRecord, type JobStatus, Worker, registerModuleRuntime } from "../jobs/index.ts";
import { log } from "../log.ts";
import { Registry } from "../registry.ts";

export interface JobsCommand {
  action: "enqueue" | "list" | "cancel" | "retry";
  /** `enqueue`: module id and job name. `list`: an optional module id. `cancel`, `retry`: the job id. */
  args: string[];
  payload: unknown;
  delaySeconds: number | undefined;
  dedupeKey: string | undefined;
  status: JobStatus | undefined;
  json: boolean;
}

export interface CliOutput {
  out: (line: string) => void;
  err: (line: string) => void;
}

const ERROR_COLUMN = 60;

function printTable(records: JobRecord[], io: CliOutput): void {
  const when = (date: Date | null) => (date === null ? "-" : date.toISOString().slice(0, 19).replace("T", " "));
  const rows = records.map((r) => [String(r.id), r.moduleId, r.name, r.status, `${r.attempts}/${r.maxAttempts}`, when(r.runAt), (r.lastError ?? "").replace(/\s+/g, " ").slice(0, ERROR_COLUMN)]);
  const titles = ["ID", "MODULE", "JOB", "STATUS", "ATTEMPTS", "RUN AT", "ERROR"];
  const widths = titles.map((title, i) => Math.max(title.length, ...rows.map((row) => row[i]!.length)));
  const line = (cells: string[]) => cells.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").trimEnd();
  io.out(line(titles));
  for (const row of rows) io.out(line(row));
}

/** `jobs enqueue|list|cancel|retry`. A payload appears only with `--json`, because a module may have put anything in it. */
export async function runJobsCommand(command: JobsCommand, deps: { pool: pg.Pool; registry: Registry; io: CliOutput }): Promise<void> {
  const { pool, registry, io } = deps;
  const service = new JobService(pool, registry);
  if (command.action === "enqueue") {
    const [moduleId, name] = command.args as [string, string];
    const options = {
      ...(command.delaySeconds === undefined ? {} : { delaySeconds: command.delaySeconds }),
      ...(command.dedupeKey === undefined ? {} : { dedupeKey: command.dedupeKey }),
    };
    const { id, deduplicated } = await service.enqueue(moduleId, name, command.payload, options, "cli");
    io.out(deduplicated ? `job ${id} (${moduleId} ${name}) is already active for that dedupe key` : `queued job ${id} (${moduleId} ${name})`);
    return;
  }
  if (command.action === "list") {
    const records = await service.list({
      ...(command.args[0] === undefined ? {} : { moduleId: command.args[0] }),
      ...(command.status === undefined ? {} : { status: command.status }),
      payload: command.json,
    });
    if (command.json) io.out(JSON.stringify(records, null, 2));
    else if (records.length === 0) io.out("no jobs");
    else printTable(records, io);
    return;
  }
  const id = Number(command.args[0]);
  if (command.action === "cancel") {
    const job = await service.cancel(id);
    io.out(`cancelled job ${job.id} (${job.moduleId} ${job.name})`);
    return;
  }
  const job = await service.retry(id);
  io.out(`queued job ${job.id} again (${job.moduleId} ${job.name})`);
}

export interface WorkerCommand {
  modulesDir: string;
  concurrency: number | undefined;
  pollMs: number | undefined;
  graceSeconds: number | undefined;
}

async function readRegistry(modulesDir: string): Promise<{ registry: Registry; manifests: ModuleManifest[] }> {
  const registry = new Registry({ allowUnsupportedPlatform: true });
  registry.registerCore();
  const { modules } = await discoverModules(modulesDir, { freshImport: true });
  for (const manifest of modules) registry.register(manifest);
  return { registry, manifests: modules };
}

/**
 * `worker`: runs until `signal` aborts. It registers what module code reaches through the SDK, reads the manifests
 * from the modules folder (again whenever the enabled set changes), and loads each handler from its module's folder.
 * Code is loaded once, so after upgrading a module the worker is restarted. Returns how many jobs it left running
 * when the grace period ended.
 */
export async function runWorkerCommand(command: WorkerCommand, deps: { pool: pg.Pool; signal: AbortSignal }): Promise<number> {
  const { pool, signal } = deps;
  const present = await pool.query("select to_regclass('core.jobs') is not null as present");
  if (!present.rows[0].present) throw new Error('the jobs table does not exist yet: run "npm run db:migrate" first');

  const first = await readRegistry(command.modulesDir);
  const holder = { current: first.registry };
  registerModuleRuntime(pool, holder);

  const worker = new Worker({
    service: new JobService(pool, holder.current),
    events: { prune: () => new EventService(pool, holder.current).prune() },
    loadManifests: async () => {
      const { registry, manifests } = await readRegistry(command.modulesDir);
      holder.current = registry;
      return manifests;
    },
    enabledModules: async () => new Map((await pool.query("select id, installed_version from core.modules where state = 'enabled'")).rows.map((r) => [r.id as string, r.installed_version as string])),
    loadHandler: async (moduleId, entry): Promise<JobHandler> => {
      const root = resolve(command.modulesDir, moduleId);
      const file = resolve(root, entry);
      if (!file.startsWith(root + sep)) throw new Error(`the job entry "${entry}" points outside module "${moduleId}"`);
      const loaded = (await import(pathToFileURL(file).href)) as { default?: unknown };
      if (typeof loaded.default !== "function") throw new Error(`${entry} must export a function as its default export`);
      return loaded.default as JobHandler;
    },
    workerId: `${hostname()}:${process.pid}:${randomBytes(2).toString("hex")}`,
    log,
    ...(command.concurrency === undefined ? {} : { concurrency: command.concurrency }),
    ...(command.pollMs === undefined ? {} : { pollMs: command.pollMs }),
    ...(command.graceSeconds === undefined ? {} : { graceMs: command.graceSeconds * 1000 }),
  });
  return worker.run(signal);
}
