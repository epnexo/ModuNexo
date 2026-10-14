import { join } from "node:path";
import type pg from "pg";
import { readPackageName, registrationModulesFor } from "../codegen/enabled.ts";
import { DEFAULT_WEB_ROOT } from "../codegen/generate.ts";
import type { RegistrationModule } from "../codegen/render.ts";
import { LifecycleService, type UninstallMode, fileHookLoader, planTransition, readStates } from "../lifecycle/index.ts";
import { OperationBusyError, finishOperation, setStep, startOperation } from "../operations/index.ts";
import { DATA_DIR } from "../packages/paths.ts";
import { REPO_ROOT } from "../packages/context.ts";
import { ApplyFailedError, ApplyRefusedError } from "./apply.ts";
import { type BuildHandle, type BuildRunner, buildWithRollback } from "./build.ts";
import { clearJournal, writeJournal } from "./journal.ts";
import { recoverInterrupted, registryFromDisk } from "./recover.ts";

export type ChangeAction = "enable" | "disable" | "uninstall";

export interface ChangeOptions {
  pool: pg.Pool;
  moduleId: string;
  action: ChangeAction;
  /** Required for `uninstall`: `keep` leaves the schema and its migration history, `purge` drops them. */
  mode?: UninstallMode;
  actor: string;
  repoRoot?: string;
  modulesDir?: string;
  webRoot?: string;
  dataDir?: string;
  run?: BuildRunner;
  requestRestart?: () => Promise<string>;
  onStep?: (step: string, detail: string) => void;
}

export interface ChangeResult {
  operationId: number;
  moduleId: string;
  kind: ChangeAction;
  restart: string;
  warnings: string[];
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Enables, disables or uninstalls an installed module and rebuilds the web app to match, with the order and the
 * guarantees of an install: the lifecycle rules are checked first and a refusal changes nothing; the registry for
 * the state after the action is built before the database moves, so a failed build touches nothing; a failed
 * lifecycle puts the previous build and registration back; the run is journalled, recorded and restarts the server.
 */
export async function changeModule(options: ChangeOptions): Promise<ChangeResult> {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const modulesDir = options.modulesDir ?? join(repoRoot, "modules");
  const webRoot = options.webRoot ?? DEFAULT_WEB_ROOT;
  const dataDir = options.dataDir ?? DATA_DIR;
  const { pool, moduleId, action } = options;
  const warnings: string[] = [];

  warnings.push(...(await recoverInterrupted({ pool, dataDir, modulesDir, webRoot })));

  // Preflight: the lifecycle's own rules, before anything is recorded or changed.
  const before = await registryFromDisk(modulesDir, false);
  const decision = planTransition({ action, moduleId, ...(options.mode === undefined ? {} : { mode: options.mode }) }, await readStates(pool), before);
  if (!decision.ok) throw new ApplyRefusedError(decision.refusal.message);
  const { plan } = decision;
  if (plan.noop) throw new ApplyRefusedError(`module "${moduleId}": nothing to do`);

  const statusesBefore = await new LifecycleService(pool, before).list();
  const previousModules = registrationModulesFor(statusesBefore, before, modulesDir).modules;
  const manifest = before.get(moduleId)!;
  const modules: RegistrationModule[] = previousModules.filter((module) => module.manifest.id !== moduleId);
  if (action === "enable") modules.push({ manifest, packageName: readPackageName(modulesDir, moduleId) });

  let operationId: number;
  try {
    operationId = await startOperation(pool, { moduleId, version: plan.version, kind: action, actor: options.actor });
  } catch (error) {
    if (error instanceof OperationBusyError) throw new ApplyRefusedError(error.message);
    throw error;
  }

  let step = "build";
  let build: BuildHandle | undefined;
  const controller = new AbortController();
  const stopHandlers = (["SIGINT", "SIGTERM"] as const).map((signal) => {
    const handler = () => controller.abort();
    process.on(signal, handler);
    return [signal, handler] as const;
  });
  const expected = action === "enable" ? "enabled" : action === "disable" ? "disabled" : "gone";
  const journal = (phase: "building" | "lifecycle") => writeJournal(dataDir, { type: "change", moduleId, action, expected, version: plan.version, phase, webRoot });
  const progress = async (name: string, detail: string) => {
    if (controller.signal.aborted && name !== "lifecycle") throw new Error("interrupted by a signal");
    step = name;
    await setStep(pool, operationId, name, detail);
    options.onStep?.(name, detail);
  };

  try {
    await progress("build", "next build (this takes a while)");
    journal("building");
    build = await buildWithRollback({ webRoot, modules, previousModules, signal: controller.signal, ...(options.run === undefined ? {} : { run: options.run }) });

    await progress("lifecycle", `${action} ${moduleId}`);
    journal("lifecycle");
    const lifecycle = new LifecycleService(pool, before, { loadHooks: fileHookLoader(modulesDir) });
    if (action === "enable") await lifecycle.enable(moduleId);
    else if (action === "disable") await lifecycle.disable(moduleId);
    else await lifecycle.uninstall(moduleId, options.mode);
  } catch (error) {
    const notes: string[] = [];
    try {
      build?.rollback();
    } catch (undoError) {
      notes.push(`undo failed: ${message(undoError)}`);
    }
    if (step === "lifecycle") notes.push("database changes the lifecycle had already applied are not undone; the previous build keeps serving and a retry continues from there");
    const undone = !notes.some((note) => note.startsWith("undo failed"));
    if (undone) clearJournal(dataDir);
    for (const [signal, handler] of stopHandlers) process.off(signal, handler);
    const reason = `${step}: ${controller.signal.aborted ? "interrupted by a signal" : message(error)}`;
    await finishOperation(pool, operationId, undone ? "rolled_back" : "failed", [reason, ...notes].join("; "));
    const why = controller.signal.aborted ? `interrupted by a signal at "${step}"` : `failed at "${step}": ${message(error)}`;
    throw new ApplyFailedError(step, operationId, `${action} of ${moduleId} ${why}`, error);
  }

  for (const [signal, handler] of stopHandlers) process.off(signal, handler);
  build.commit();
  clearJournal(dataDir);
  let restart = "no restart was requested";
  try {
    options.onStep?.("restart", "asking the running server to restart");
    await setStep(pool, operationId, "restart");
    if (options.requestRestart !== undefined) restart = await options.requestRestart();
  } catch (error) {
    restart = `the restart could not be requested: ${message(error)}`;
    warnings.push(restart);
  }
  await finishOperation(pool, operationId, "succeeded", restart);
  return { operationId, moduleId, kind: action, restart, warnings };
}
