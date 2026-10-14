import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ModuleManifest } from "@epnexo/sdk";
import type pg from "pg";
import semver from "semver";
import { type RegistrationModule } from "../codegen/render.ts";
import { DEFAULT_WEB_ROOT } from "../codegen/generate.ts";
import { readPackageName, registrationModulesFor } from "../codegen/enabled.ts";
import { discoverModules } from "../discovery.ts";
import { LifecycleService, fileHookLoader } from "../lifecycle/index.ts";
import { OperationBusyError, finishOperation, setStep, startOperation } from "../operations/index.ts";
import { DATA_DIR, buildPackageContext, listIntakes, stagingPath, validatePackageTree } from "../packages/index.ts";
import { REPO_ROOT } from "../packages/context.ts";
import { Registry } from "../registry.ts";
import { type BuildHandle, type BuildRunner, buildWithRollback } from "./build.ts";
import { type Placement, placePackage } from "./place.ts";

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
}

export interface ApplyResult {
  operationId: number;
  moduleId: string;
  version: string;
  kind: "install" | "upgrade";
  restart: string;
  warnings: string[];
}

async function registryFrom(modulesDir: string, fresh: boolean): Promise<Registry> {
  const registry = new Registry({ allowUnsupportedPlatform: true });
  registry.registerCore();
  const { modules } = await discoverModules(modulesDir, { freshImport: fresh });
  for (const manifest of modules) registry.register(manifest);
  return registry;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

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

  const before = await registryFrom(modulesDir, false);
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
  let placement: Placement | undefined;
  let build: BuildHandle | undefined;
  try {
    await setStep(pool, operationId, "place", `${kind} ${review.id} ${review.version}`);
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
    });

    step = "verify";
    await setStep(pool, operationId, "verify", "the manifest.ts that will run is the manifest.json that was reviewed");
    const after = await registryFrom(modulesDir, true);
    const loaded = after.get(review.id);
    if (loaded === undefined) throw new ApplyRefusedError(`manifest.ts of the package does not declare module "${review.id}"`);
    const normalize = (manifest: ModuleManifest): unknown => JSON.parse(JSON.stringify(manifest));
    const expected = normalize({ ...reviewed, migrationsDir: resolve(placement.moduleDir, reviewed.migrationsDir) });
    if (!isDeepStrictEqual(normalize(loaded), expected)) {
      throw new ApplyRefusedError("manifest.ts of the package is not the manifest.json that was reviewed; the package is inconsistent and was not applied");
    }

    step = "build";
    await setStep(pool, operationId, "build", "next build");
    const lifecycle = new LifecycleService(pool, after, { loadHooks: fileHookLoader(modulesDir) });
    const registration = registrationModulesFor(await lifecycle.list(), after, modulesDir);
    warnings.push(...registration.warnings);
    const modules: RegistrationModule[] = registration.modules.filter((module) => module.manifest.id !== review.id);
    modules.push({ manifest: loaded, packageName: readPackageName(modulesDir, review.id) });
    build = await buildWithRollback({ webRoot, modules, previousModules, ...(options.run === undefined ? {} : { run: options.run }) });

    step = "lifecycle";
    await setStep(pool, operationId, "lifecycle", kind === "install" ? "migrations and hooks" : "migrations and hooks of the upgrade");
    if (kind === "install") await lifecycle.install(review.id);
    else await lifecycle.upgrade(review.id);
  } catch (error) {
    const notes: string[] = [];
    try {
      build?.rollback();
      placement?.undo();
    } catch (undoError) {
      notes.push(`undo failed: ${message(undoError)}`);
    }
    if (step === "lifecycle") notes.push("database changes the lifecycle had already applied are not undone; the previous build keeps serving and a retry continues from there");
    const reason = `${step}: ${message(error)}`;
    await finishOperation(pool, operationId, notes.some((note) => note.startsWith("undo failed")) ? "failed" : "rolled_back", [reason, ...notes].join("; "));
    if (error instanceof ApplyRefusedError) throw error;
    throw new ApplyFailedError(step, operationId, `${kind} of ${review.id} ${review.version} failed at "${step}": ${message(error)}`, error);
  }

  build.commit();
  let restart = "no restart was requested";
  try {
    await setStep(pool, operationId, "restart");
    if (options.requestRestart !== undefined) restart = await options.requestRestart();
  } catch (error) {
    restart = `the restart could not be requested: ${message(error)}`;
    warnings.push(restart);
  }
  await finishOperation(pool, operationId, "succeeded", restart);
  return { operationId, moduleId: review.id, version: review.version, kind, restart, warnings };
}
