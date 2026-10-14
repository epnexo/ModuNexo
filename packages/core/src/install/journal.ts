import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PlacementState } from "./place.ts";

export type ApplyPhase = "placing" | "building" | "lifecycle";

/**
 * What an apply run is changing, written before it changes it and removed when it finishes. A process that dies
 * in the middle leaves it behind, and the next run uses it to put things back (or to finish, if the database step
 * had completed).
 */
export interface ApplyJournal extends PlacementState {
  /** The version being installed or upgraded to. */
  version: string;
  phase: ApplyPhase;
  webRoot: string;
}

export const journalPath = (dataDir: string): string => join(dataDir, "run", "apply.journal.json");

export function writeJournal(dataDir: string, journal: ApplyJournal): void {
  const file = journalPath(dataDir);
  mkdirSync(dirname(file), { recursive: true });
  const partial = `${file}.part`;
  writeFileSync(partial, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
  renameSync(partial, file);
}

const isString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isStringOrNull = (value: unknown): value is string | null => value === null || isString(value);

/** The journal, or null when there is none or it is not one this code wrote. */
export function readJournal(dataDir: string): ApplyJournal | null {
  try {
    const raw = JSON.parse(readFileSync(journalPath(dataDir), "utf8")) as Record<string, unknown>;
    const ok =
      (raw.kind === "install" || raw.kind === "upgrade") &&
      isString(raw.moduleId) &&
      isString(raw.modulesDir) &&
      isString(raw.moduleDir) &&
      isString(raw.linkPath) &&
      isString(raw.linkTarget) &&
      typeof raw.createLink === "boolean" &&
      isStringOrNull(raw.scopeDir) &&
      isStringOrNull(raw.previousDir) &&
      isString(raw.version) &&
      (raw.phase === "placing" || raw.phase === "building" || raw.phase === "lifecycle") &&
      isString(raw.webRoot);
    return ok ? (raw as unknown as ApplyJournal) : null;
  } catch {
    return null;
  }
}

export function clearJournal(dataDir: string): void {
  rmSync(journalPath(dataDir), { force: true });
}
