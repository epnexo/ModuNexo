import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDistName } from "./dist.ts";
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
  /**
   * The build directory this run writes (see dist.ts), so a recovery knows which one to remove, or to put in service.
   * A journal written before builds had directories of their own has none.
   */
  dist?: string;
}

/** A change of state (enable, disable, uninstall): no files are placed, only the build and the database move. */
export interface ChangeJournal {
  type: "change";
  moduleId: string;
  action: "enable" | "disable" | "uninstall";
  /** What `core.modules` shows for the module once the database step has completed. */
  expected: "enabled" | "disabled" | "gone";
  version: string;
  phase: ApplyPhase;
  webRoot: string;
  dist?: string;
}

export type AnyJournal = ApplyJournal | ChangeJournal;

export const isChange = (journal: AnyJournal): journal is ChangeJournal => "type" in journal && journal.type === "change";

export const journalPath = (dataDir: string): string => join(dataDir, "run", "apply.journal.json");

export function writeJournal(dataDir: string, journal: AnyJournal): void {
  const file = journalPath(dataDir);
  mkdirSync(dirname(file), { recursive: true });
  const partial = `${file}.part`;
  writeFileSync(partial, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
  renameSync(partial, file);
}

const isString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isOptionalDist = (value: unknown): boolean => value === undefined || (typeof value === "string" && isDistName(value));
const isStringOrNull = (value: unknown): value is string | null => value === null || isString(value);

/** The journal, or null when there is none or it is not one this code wrote. */
export function readJournal(dataDir: string): AnyJournal | null {
  try {
    const raw = JSON.parse(readFileSync(journalPath(dataDir), "utf8")) as Record<string, unknown>;
    if (raw.type === "change") {
      const changeOk =
        (raw.action === "enable" || raw.action === "disable" || raw.action === "uninstall") &&
        (raw.expected === "enabled" || raw.expected === "disabled" || raw.expected === "gone") &&
        isString(raw.moduleId) &&
        isString(raw.version) &&
        (raw.phase === "placing" || raw.phase === "building" || raw.phase === "lifecycle") &&
        isString(raw.webRoot) &&
        isOptionalDist(raw.dist);
      return changeOk ? (raw as unknown as ChangeJournal) : null;
    }
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
      isString(raw.webRoot) &&
      isOptionalDist(raw.dist);
    return ok ? (raw as unknown as ApplyJournal) : null;
  } catch {
    return null;
  }
}

export function clearJournal(dataDir: string): void {
  rmSync(journalPath(dataDir), { force: true });
}
