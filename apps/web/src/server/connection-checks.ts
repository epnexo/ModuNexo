import type { ModuleManifest } from "@modunexo/sdk";

/** One connection check as the Settings screen shows it: plain strings only. */
export interface CheckView {
  key: string;
  label: string;
  description: string | null;
  path: string;
}

/** What the screen shows after a check ran. */
export interface CheckOutcome {
  ok: boolean;
  message: string;
}

const MAX_MESSAGE_CHARS = 300;

/** The checks a module declares, in the order it declares them. The manifest validator already ensured each path is a guarded POST route of the module. */
export function buildChecksView(manifest: Pick<ModuleManifest, "checks">): CheckView[] {
  return (manifest.checks ?? []).map((check) => ({ key: check.key, label: check.label, description: check.description ?? null, path: check.path }));
}

/** One short plain line: control characters become spaces and the length is bounded, whatever the module sent. */
function plain(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_MESSAGE_CHARS);
}

/**
 * Turns the answer of a check route into what the screen shows. The contract is `{ ok: boolean, message: string }`; `ok` only
 * counts on a 2xx answer. A refused session and anything that is not the contract get a fixed sentence of the platform's own,
 * so a route can never put its own text where the platform speaks.
 */
export function readCheckAnswer(status: number, body: unknown): CheckOutcome {
  if (status === 403) return { ok: false, message: "Your session cannot run this check. Sign in again or ask for the permission." };
  if (typeof body === "object" && body !== null && !Array.isArray(body)) {
    const { ok, message } = body as { ok?: unknown; message?: unknown };
    if (typeof ok === "boolean" && typeof message === "string") return { ok: ok && status >= 200 && status < 300, message: plain(message) };
  }
  return { ok: false, message: `The check did not answer as expected (${status}).` };
}
