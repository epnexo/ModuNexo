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
const EMPTY_MESSAGE = "The check ran but sent no message.";
/** Control characters, bidirectional overrides and isolates, zero-width characters and line separators: none belongs in one plain line. */
const NOT_PLAIN = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2028\u2029\u2066-\u2069\ufeff]/g;

/** The checks a module declares, in the order it declares them. The manifest validator already ensured each path is a guarded POST route of the module. */
export function buildChecksView(manifest: Pick<ModuleManifest, "checks">): CheckView[] {
  return (manifest.checks ?? []).map((check) => ({ key: check.key, label: check.label, description: check.description ?? null, path: check.path }));
}

/** One short plain line: line breaks and tabs become spaces, characters that hide or reorder text are dropped, and the length is bounded, whatever the module sent. */
function plain(text: string): string {
  return text.replace(/[\t\n\r\f\v]+/g, " ").replace(NOT_PLAIN, "").replace(/\s+/g, " ").trim().slice(0, MAX_MESSAGE_CHARS);
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
    if (typeof ok === "boolean" && typeof message === "string") return { ok: ok && status >= 200 && status < 300, message: plain(message) || EMPTY_MESSAGE };
  }
  return { ok: false, message: `The check did not answer as expected (${status}).` };
}
