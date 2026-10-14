import semver from "semver";

/** A row of `core.module_operations` as the API sends it (dates as ISO strings). */
export interface RunRow {
  id: number;
  moduleId: string;
  version: string;
  kind: "install" | "upgrade";
  status: "running" | "succeeded" | "failed" | "rolled_back";
  step: string;
  detail: string | null;
  actor: string;
  startedAt: string;
  finishedAt: string | null;
}

export interface PlannedAction {
  kind: "install" | "upgrade";
  label: string;
  /** Why the package cannot be applied, or null. */
  blocked: string | null;
}

/** What confirming a reviewed package would do, given the version installed now (undefined when none). */
export function planAction(review: { id: string; version: string }, installed: string | undefined): PlannedAction {
  if (installed === undefined) return { kind: "install", label: `Install ${review.id} ${review.version}`, blocked: null };
  const label = `Upgrade ${review.id} ${installed} to ${review.version}`;
  if (semver.valid(installed) !== null && semver.valid(review.version) !== null) {
    if (semver.eq(review.version, installed)) return { kind: "upgrade", label, blocked: `${review.id} ${installed} is already installed.` };
    if (semver.lt(review.version, installed)) return { kind: "upgrade", label, blocked: `${review.version} is older than the installed ${installed}; an upgrade needs a newer version.` };
  }
  return { kind: "upgrade", label, blocked: null };
}

const STEPS: Record<string, string> = {
  start: "starting",
  place: "placing the package",
  verify: "checking the package against what was reviewed",
  build: "building the web app",
  lifecycle: "running migrations and hooks",
  restart: "restarting the server",
};

export const stepLabel = (step: string): string => STEPS[step] ?? step;

export const isFinished = (run: Pick<RunRow, "status">): boolean => run.status !== "running";

/** One sentence for a run, running or finished. */
export function runSummary(run: RunRow): string {
  const subject = `${run.moduleId} ${run.kind === "upgrade" ? "to " : ""}${run.version}`;
  const detail = run.detail === null || run.detail === "" ? "" : run.detail;
  switch (run.status) {
    case "running": {
      const doing = stepLabel(run.step);
      const extra = detail !== "" && run.step === "build" ? ` (${detail})` : "";
      return `${run.kind === "upgrade" ? "Upgrading" : "Installing"} ${subject}: ${doing}${extra}`;
    }
    case "succeeded":
      return `${run.kind === "upgrade" ? "Upgraded" : "Installed"} ${subject}.${detail === "" ? "" : ` ${detail}`}`;
    case "rolled_back":
      return `Rolled back ${run.kind} of ${subject}.${detail === "" ? "" : ` ${detail}`}`;
    case "failed":
      return `Failed ${run.kind} of ${subject}.${detail === "" ? "" : ` ${detail}`}`;
  }
}
