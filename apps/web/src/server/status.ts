import type { JobRecord } from "@modunexo/core/jobs";
import { LlmError, type LlmProbeResult, type ModuleManifest } from "@modunexo/sdk";

/** How much of a job's last error the status screen shows. */
export const ERROR_CHARS = 200;

/** One tidy line: control characters become spaces, runs of whitespace one space, and a long text is cut with an ellipsis. Null when nothing is left. */
export function cutText(text: string | null, max = ERROR_CHARS): string | null {
  if (text === null) return null;
  const tidy = text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (tidy === "") return null;
  const characters = Array.from(tidy);
  return characters.length > max ? `${characters.slice(0, max - 1).join("")}…` : tidy;
}

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** A size as a person reads it: 512 B, 1.5 KB, 15 KB, 3.2 MB. Anything that is not a size is 0 B. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1) return "0 B";
  if (bytes < 1024) return `${Math.floor(bytes)} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${UNITS[unit]}`;
}

/** A length of time in the largest unit that fits: 45 s, 2 min, 3 h, 1 d. */
export function formatWait(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

/** How long ago `date` was, for a table: "just now" under five seconds, which is also what a clock a little ahead reads. */
export function formatAgo(date: Date, now: Date): string {
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);
  return seconds < 5 ? "just now" : `${formatWait(seconds)} ago`;
}

/**
 * The line that tells an administrator jobs are waiting for a worker nobody started. It is an inference (no heartbeat says a
 * worker is alive): jobs that are due and have waited a minute are the sign. Null while there is nothing to say.
 */
export function workerLine(due: { count: number; waitingSeconds: number | null }): string | null {
  if (due.count === 0 || due.waitingSeconds === null || due.waitingSeconds < 60) return null;
  const one = due.count === 1;
  return `${due.count} ${one ? "job has" : "jobs have"} been due for ${formatWait(due.waitingSeconds)} and nobody has taken ${one ? "it" : "them"}. Is the worker running? Start it with: npm run modunexo -- worker`;
}

export interface TroubleRow {
  id: number;
  moduleId: string;
  name: string;
  state: "dead" | "retrying";
  attempts: string;
  when: string;
  error: string | null;
}

/** The jobs that need a look, with what a person needs and nothing else: no payload, dedupe key or enqueuer. */
export function troubleRows(jobs: readonly JobRecord[], now: Date): TroubleRow[] {
  return jobs.map((job) => ({
    id: job.id,
    moduleId: job.moduleId,
    name: job.name,
    state: job.status === "dead" ? "dead" : "retrying",
    attempts: `${job.attempts} of ${job.maxAttempts}`,
    when: formatAgo(job.finishedAt ?? job.startedAt ?? job.createdAt, now),
    error: cutText(job.lastError),
  }));
}

export interface ModelRow {
  id: string;
  name: string;
  endpointSetting: string;
  keySetting: string | null;
  modelSetting: string | null;
}

/** The enabled modules that call a model, by name, with the settings that configure it (their keys, never their values). */
export function modelRows(manifests: readonly Pick<ModuleManifest, "id" | "name" | "llm">[], enabled: ReadonlySet<string>): ModelRow[] {
  return manifests
    .filter((manifest) => manifest.llm !== undefined && enabled.has(manifest.id))
    .map((manifest) => ({
      id: manifest.id,
      name: manifest.name,
      endpointSetting: manifest.llm!.baseUrlSetting,
      keySetting: manifest.llm!.apiKeySetting ?? null,
      modelSetting: manifest.llm!.modelSetting ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** What a connection test found, as sentences. A probe lists at most 50 models, so 50 means "that many or more". */
export function probeSummary(result: LlmProbeResult): string[] {
  const count = result.models.length;
  const listed = count >= 50 ? "The provider lists 50 or more models." : `The provider lists ${count} ${count === 1 ? "model" : "models"}.`;
  const model =
    result.model === null ? "No model is set for this module." : result.modelAvailable === true ? `The model "${result.model}" is listed.` : `The model "${result.model}" is not listed by the provider.`;
  return [`Reached ${result.endpoint} in ${result.latencyMs} ms.`, listed, model];
}

/** A refusal the platform raised, with its code; anything else is reported as unexpected and says nothing of what it was. */
export function probeError(error: unknown): { code: string; message: string } {
  if (error instanceof LlmError) return { code: error.code, message: error.message };
  return { code: "unexpected", message: "The test failed for a reason the platform did not expect; the server log has the details." };
}

export interface ProbeDeps {
  service: { probe(moduleId: string): Promise<LlmProbeResult> };
  manifests: readonly Pick<ModuleManifest, "id" | "llm">[];
  enabled: ReadonlySet<string>;
  /** Told about an error the platform did not raise itself, which the browser is not: the log has to have it. */
  onUnexpected?: (error: unknown) => void;
}

export type ProbeReply = { status: 200; body: { lines: string[] } } | { status: 404 | 422 | 500 | 502; body: { error: string; code: string } };

/**
 * The connection test for one module, as the route answers it. Only an enabled module that declares `llm` is tested; anything
 * else is 404 and nothing is called. A module that is not set up is 422, a provider that refuses is 502, and an error nobody
 * expected is 500 with nothing of what it said.
 */
export async function runProbe(deps: ProbeDeps, moduleId: string): Promise<ProbeReply> {
  const manifest = deps.manifests.find((candidate) => candidate.id === moduleId);
  if (manifest?.llm === undefined || !deps.enabled.has(moduleId)) return { status: 404, body: { error: "this module does not call a model", code: "not_found" } };
  try {
    return { status: 200, body: { lines: probeSummary(await deps.service.probe(moduleId)) } };
  } catch (error) {
    const refusal = probeError(error);
    if (refusal.code === "unexpected") deps.onUnexpected?.(error);
    const status = refusal.code === "unexpected" ? 500 : refusal.code === "not_configured" ? 422 : 502;
    return { status, body: { error: refusal.message, code: refusal.code } };
  }
}
