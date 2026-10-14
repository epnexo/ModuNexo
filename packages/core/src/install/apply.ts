import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ModuleManifest } from "@epnexo/sdk";
import type pg from "pg";
import semver from "semver";
import { type RegistrationModule } from "../codegen/render.ts";
import { DEFAULT_WEB_ROOT } from "../codegen/generate.ts";
import { readPackageName, registrationModulesFor } from "../codegen/enabled.ts";
import { LifecycleService, fileHookLoader } from "../lifecycle/index.ts";
import { OperationBusyError, finishOperation, setStep, startOperation } from "../operations/index.ts";
import { DATA_DIR, buildPackageContext, listIntakes, stagingPath, validatePackageTree } from "../packages/index.ts";
import { REPO_ROOT } from "../packages/context.ts";
import { BuildFailedError, type BuildHandle, type BuildRunner, buildWithRollback } from "./build.ts";
import { clearJournal, writeJournal } from "./journal.ts";
import { type Placement, placePackage } from "./place.ts";
import { recoverInterrupted, registryFromDisk } from "./recover.ts";

/** The package cannot be applied, and nothing was changed (or everything that was changed has been undone). */
export class ApplyRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApplyRefusedError";
  }
}

/** A step failed after the run began. What it changed has been undone as far as it can be undone. */
export class ApplyFailedError extends Error {
  readonly step: string;
  readonly operationId: number;
  constructor(step: string, operationId: number, message: string, cause: unknown) {
    super(message, { cause });
    this.name = "ApplyFailedError";
    this.step = step;
    this.operationId = operationId;
  }
}

export interface ApplyOptions {
  pool: pg.Pool;
  sha256: string;
  actor: string;
  repoRoot?: string;
  modulesDir?: string;
  webRoot?: string;
  dataDir?: string;
  /** How the web app is built; `next build` by default. */
  run?: BuildRunner;
  /** Asks the running server to restart and says what happened. Default: nothing is asked. */
  requestRestart?: () => Promise<string>;
  /** Called as each step begins, for a command line that shows progress. */
  onStep?: (step: string, detail: string) => void;
}

export interface ApplyResult {
  operationId: number;
  moduleId: string;
  version: string;
  kind: "install" | "upgrade";
  restart: string;
  warnings: string[];
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** What a failure says, with the end of the build's own output when it was the build that failed. */
const reasonOf = (error: unknown): string => {
  if (error instanceof BuildFailedError) {
    const tail = error.output.trim().split("\n").slice(-12).join("\n").slice(-1200);
    return tail === "" ? message(error) : `${message(error)}\n${tail}`;
  }
  return message(error);
};

/**
 * Installs or upgrades a staged package: places it, builds the web app with it registered, runs the lifecycle,
 * and asks for a restart. The build comes before the database so that a build that fails touches nothing; every
 * failure undoes the files and the build, and the run is recorded either way. Only one run happens at a time.
 */
export async function applyPackage(options: ApplyOptions): Promise<ApplyResult> {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const modulesDir = options.modulesDir ?? join(repoRoot, "modules");
  const webRoot = options.webRoot ?? DEFAULT_WEB_ROOT;
  const dataDir = options.dataDir ?? DATA_DIR;
  const { pool, sha256 } = options;
  const warnings: string[] = [];

  // A run that was killed leaves a journal; put its changes back before looking at anything else.
  warnings.push(...(await recoverInterrupted({ pool, dataDir, modulesDir, webRoot })));

  // Preflight: everything that can be refused without changing a thing.
  const intakes = await listIntakes(pool, { sha256, limit: 20 });
  if (intakes.length === 0) throw new ApplyRefusedError(`no package with SHA-256 ${sha256} was brought in; run "modules add" first`);
  if (!intakes.some((row) => row.status === "staged")) throw new ApplyRefusedError(`the package ${sha256} was refused at intake and cannot be applied`);
  const staging = stagingPath(dataDir, sha256);
  if (!existsSync(staging)) throw new ApplyRefusedError(`the staged tree of ${sha256} is no longer on disk; run "modules add" again`);

  const context = await buildPackageContext({ modulesDir, repoRoot, pool });
  const validation = validatePackageTree(staging, context);
  if (!validation.ok) throw new ApplyRefusedError(`the package no longer passes the platform's checks:\n  ${validation.problems.join("\n  ")}`);
  const { review, manifest: reviewed } = validation;
  const packageName = review.packageName;

  const before = await registryFromDisk(modulesDir, false);
  const statusesBefore = await new LifecycleService(pool, before).list();
  const current = statusesBefore.find((status) => status.id === review.id);
  const installed = current?.installedVersion;
  const kind: "install" | "upgrade" = installed === undefined ? "install" : "upgrade";
  if (installed !== undefined && semver.valid(installed) !== null && !semver.gt(review.version, installed)) {
    throw new ApplyRefusedError(`${review.id} ${review.version} is not newer than the installed ${installed}; an upgrade needs a greater version`);
  }
  const previousModules = registrationModulesFor(statusesBefore, before, modulesDir).modules;

  let operationId: number;
  try {
    operationId = await startOperation(pool, { moduleId: review.id, version: review.version, sha256, kind, actor: options.actor });
  } catch (error) {
    if (error instanceof OperationBusyError) throw new ApplyRefusedError(error.message);
    throw error;
  }

  let step = "place";
  const progress = async (name: string, detail: string) => {
    if (controller.signal.aborted && name !== "lifecycle") throw new Error("interrupted by a signal");
    step = name;
    await setStep(pool, operationId, name, detail);
    options.onStep?.(name, detail);
  };
  let placement: Placement | undefined;
  let build: BuildHandle | undefined;

  // A stop signal during the build aborts it and rolls back; during the database step it waits for that step.
  const controller = new AbortController();
  const stopHandlers = (["SIGINT", "SIGTERM"] as const).map((signal) => {
    const handler = () => controller.abort();
    process.on(signal, handler);
    return [signal, handler] as const;
  });
  const journalBase = { version: review.version, webRoot };
  const setPhase = (phase: "building" | "lifecycle") => {
    if (placement !== undefined) writeJournal(dataDir, { ...placement.state, ...journalBase, phase });
  };
  try {
    await progress("place", `${kind} ${review.id} ${review.version}`);
    placement = placePackage({
      stagingDir: staging,
      moduleId: review.id,
      packageName,
      version: review.version,
      kind,
      ...(installed === undefined ? {} : { previousVersion: installed }),
      modulesDir,
      nodeModulesDir: join(repoRoot, "node_modules"),
      dataDir,
      beforeChange: (state) => writeJournal(dataDir, { ...state, ...journalBase, phase: "placing" }),
    });

    await progress("verify", "the manifest.ts that will run is the manifest.json that was reviewed");
    const after = await registryFromDisk(modulesDir, true);
    const loaded = after.get(review.id);
    if (loaded === undefined) throw new ApplyRefusedError(`manifest.ts of the package does not declare module "${review.id}"`);
    const normalize = (manifest: ModuleManifest): unknown => JSON.parse(JSON.stringify(manifest));
    const expected = normalize({ ...reviewed, migrationsDir: resolve(placement.moduleDir, reviewed.migrationsDir) });
    if (!isDeepStrictEqual(normalize(loaded), expected)) {
      throw new ApplyRefusedError("manifest.ts of the package is not the manifest.json that was reviewed; the package is inconsistent and was not applied");
    }

    await progress("build", "next build (this takes a while)");
    const lifecycle = new LifecycleService(pool, after, { loadHooks: fileHookLoader(modulesDir) });
    const registration = registrationModulesFor(await lifecycle.list(), after, modulesDir);
    warnings.push(...registration.warnings);
    const modules: RegistrationModule[] = registration.modules.filter((module) => module.manifest.id !== review.id);
    // An install is enabled by the lifecycle, so it is built in; an upgrade keeps the state the module had, so a
    // disabled module stays out of the build as codegen's "enabled only" rule has it.
    if (kind === "install" || current?.status === "enabled") modules.push({ manifest: loaded, packageName: readPackageName(modulesDir, review.id) });
    setPhase("building");
    build = await buildWithRollback({
      webRoot,
      modules,
      previousModules,
      signal: controller.signal,
      ...(options.run === undefined ? {} : { run: options.run }),
    });

    await progress("lifecycle", kind === "install" ? "migrations and hooks" : "migrations and hooks of the upgrade");
    setPhase("lifecycle");
    if (kind === "install") await lifecycle.install(review.id);
    else await lifecycle.upgrade(review.id);
  } catch (error) {
    const notes: string[] = [];
    // Each undo is tried on its own: a build that cannot be restored must not stop the files being put back.
    for (const undo of [() => build?.rollback(), () => placement?.undo()]) {
      try {
        undo();
      } catch (undoError) {
        notes.push(`undo failed: ${message(undoError)}`);
      }
    }
    if (step === "lifecycle") notes.push("database changes the lifecycle had already applied are not undone; the previous build keeps serving and a retry continues from there");
    const reason = `${step}: ${controller.signal.aborted ? "interrupted by a signal" : reasonOf(error)}`;
    const undone = !notes.some((note) => note.startsWith("undo failed"));
    if (undone) clearJournal(dataDir);
    for (const [signal, handler] of stopHandlers) process.off(signal, handler);
    await finishOperation(pool, operationId, undone ? "rolled_back" : "failed", [reason, ...notes].join("; "));
    if (error instanceof ApplyRefusedError) throw error;
    const why = controller.signal.aborted ? `interrupted by a signal at "${step}"` : `failed at "${step}": ${message(error)}`;
    throw new ApplyFailedError(step, operationId, `${kind} of ${review.id} ${review.version} ${why}`, error);
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
  return { operationId, moduleId: review.id, version: review.version, kind, restart, warnings };
}
