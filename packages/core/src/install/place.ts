import { randomBytes } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, rmdirSync, symlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";

/** The package could not be put in place; nothing was changed. */
export class PlacementRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlacementRefusedError";
  }
}

const MODULE_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const VERSION = /^[0-9A-Za-z.+-]{1,64}$/;

export interface PlaceOptions {
  /** The validated, unpacked package (`var/staging/<sha256>`). It is copied, never moved or modified. */
  stagingDir: string;
  moduleId: string;
  packageName: string;
  version: string;
  kind: "install" | "upgrade";
  /** Required for an upgrade: the version being replaced, which names the folder it is kept in. */
  previousVersion?: string;
  modulesDir: string;
  /** The repository's `node_modules`, where a workspace link would be. */
  nodeModulesDir: string;
  dataDir: string;
  /**
   * Called with what is about to change, before anything does. The pipeline writes it to its journal, so a process
   * that dies half way can be undone by the next run from `undoPlacement`.
   */
  beforeChange?: (state: PlacementState) => void;
}

/** What a placement changes, as plain data: enough to undo it later without the process that made it. */
export interface PlacementState {
  kind: "install" | "upgrade";
  moduleId: string;
  modulesDir: string;
  moduleDir: string;
  /** The `node_modules` link and what it points to. */
  linkPath: string;
  linkTarget: string;
  /** Only an install that finds no link makes one; an upgrade never touches it. */
  createLink: boolean;
  /** The scope folder (`node_modules/@scope`) that did not exist and will be created, if any. */
  scopeDir: string | null;
  /** Where the replaced version goes; null for an install. */
  previousDir: string | null;
}

export interface Placement {
  moduleDir: string;
  linkPath: string;
  /** Where the replaced version was moved to; null for an install. */
  previousDir: string | null;
  state: PlacementState;
  /** Puts everything back as it was before `placePackage`. Safe to call once. */
  undo: () => void;
}

/**
 * Puts back what `placePackage` changed (or was about to). It is safe at any point of a placement and safe to
 * repeat: it removes only what the state says the placement made, and an upgrade's current folder is replaced by
 * the kept previous one only when that one exists, so a run that died before moving anything destroys nothing.
 */
export function undoPlacement(state: PlacementState): void {
  if (existsSync(state.modulesDir)) {
    for (const name of readdirSync(state.modulesDir)) {
      if (name.startsWith(`.${state.moduleId}.incoming-`)) rmSync(join(state.modulesDir, name), { recursive: true, force: true });
    }
  }
  if (state.kind === "upgrade") {
    if (state.previousDir !== null && existsSync(state.previousDir)) {
      rmSync(state.moduleDir, { recursive: true, force: true });
      renameSync(state.previousDir, state.moduleDir);
    }
    return;
  }
  rmSync(state.moduleDir, { recursive: true, force: true });
  if (state.createLink) {
    try {
      if (lstatSync(state.linkPath).isSymbolicLink() && readlinkSync(state.linkPath) === state.linkTarget) rmSync(state.linkPath, { force: true });
    } catch {
      // No link: nothing to remove.
    }
  }
  if (state.scopeDir !== null) {
    try {
      if (readdirSync(state.scopeDir).length === 0) rmdirSync(state.scopeDir);
    } catch {
      // Already gone or not empty: nothing of ours to remove.
    }
  }
}

function packageNameOf(dir: string): string | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const name = typeof raw === "object" && raw !== null ? (raw as { name?: unknown }).name : undefined;
    return typeof name === "string" ? name : null;
  } catch {
    return null;
  }
}

/** `<id>-<version>`, or with a numeric suffix when a folder of that name is already kept. */
function freshPreviousDir(dataDir: string, moduleId: string, version: string): string {
  const base = join(dataDir, "previous", `${moduleId}-${version}`);
  if (!existsSync(base)) return base;
  for (let n = 2; n < 1000; n += 1) if (!existsSync(`${base}.${n}`)) return `${base}.${n}`;
  throw new PlacementRefusedError(`too many kept copies of ${moduleId} ${version}`);
}

/**
 * Takes an uninstalled module out of the way so the same id can be installed again: the folder moves to
 * `var/removed/<id>-<version>` (kept, never deleted) and its workspace link is removed. Returns where it went,
 * or null when there was nothing to move.
 */
export function removePackage(options: { moduleId: string; packageName: string; version: string; modulesDir: string; nodeModulesDir: string; dataDir: string }): string | null {
  const { moduleId, packageName, version } = options;
  if (!MODULE_ID.test(moduleId) || !PACKAGE_NAME.test(packageName) || !VERSION.test(version)) throw new PlacementRefusedError("not a module to remove");
  const moduleDir = join(options.modulesDir, moduleId);
  const linkPath = join(options.nodeModulesDir, ...packageName.split("/"));
  try {
    if (lstatSync(linkPath).isSymbolicLink() && readlinkSync(linkPath) === relative(dirname(linkPath), moduleDir)) rmSync(linkPath);
  } catch {
    // no link to remove
  }
  if (!existsSync(moduleDir)) return null;
  const base = join(options.dataDir, "removed", `${moduleId}-${version}`);
  let target = base;
  for (let n = 2; existsSync(target); n += 1) {
    if (n >= 1000) throw new PlacementRefusedError(`too many kept copies of ${moduleId} ${version}`);
    target = `${base}.${n}`;
  }
  mkdirSync(dirname(target), { recursive: true });
  renameSync(moduleDir, target);
  return target;
}

/**
 * Makes a staged package a module the platform can see: a copy at `modules/<id>` and a relative symlink at
 * `node_modules/<package name>`, which is what a workspace install would have made. No package manager runs.
 * An upgrade moves the folder it replaces to `var/previous/<id>-<version>`; `undo` puts it back.
 */
export function placePackage(options: PlaceOptions): Placement {
  const { moduleId, packageName, kind } = options;
  if (!MODULE_ID.test(moduleId) || moduleId.length > 64) throw new PlacementRefusedError(`"${moduleId}" is not a module id`);
  if (!PACKAGE_NAME.test(packageName) || packageName.length > 214) throw new PlacementRefusedError(`"${packageName}" is not a package name`);
  if (!VERSION.test(options.version) || (options.previousVersion !== undefined && !VERSION.test(options.previousVersion))) {
    throw new PlacementRefusedError("a version is not valid for a folder name");
  }
  if (!existsSync(options.stagingDir) || !lstatSync(options.stagingDir).isDirectory()) throw new PlacementRefusedError("the staged package is not there");

  const moduleDir = join(options.modulesDir, moduleId);
  const linkPath = join(options.nodeModulesDir, ...packageName.split("/"));
  const linkTarget = relative(dirname(linkPath), moduleDir);
  const exists = (() => {
    try {
      lstatSync(moduleDir);
      return true;
    } catch {
      return false;
    }
  })();

  let previousDir: string | null = null;
  if (kind === "install") {
    if (exists) throw new PlacementRefusedError(`modules/${moduleId} already exists; an installed module is changed by an upgrade`);
  } else {
    if (!exists) throw new PlacementRefusedError(`modules/${moduleId} has no folder to upgrade`);
    if (options.previousVersion === undefined) throw new PlacementRefusedError("an upgrade needs the version it replaces");
    const current = packageNameOf(moduleDir);
    if (current !== packageName) throw new PlacementRefusedError(`the package name changed from ${JSON.stringify(current)} to "${packageName}"; an upgrade keeps its name`);
    previousDir = freshPreviousDir(options.dataDir, moduleId, options.previousVersion);
  }

  let createLink = false;
  if (kind === "install") {
    let present = false;
    try {
      lstatSync(linkPath);
      present = true;
    } catch {
      present = false;
    }
    if (present) {
      const sameLink = lstatSync(linkPath).isSymbolicLink() && readlinkSync(linkPath) === linkTarget;
      if (!sameLink) throw new PlacementRefusedError(`node_modules/${packageName} is already taken by something else`);
    } else createLink = true;
  }
  const scopeDir = createLink && packageName.startsWith("@") && !existsSync(dirname(linkPath)) ? dirname(linkPath) : null;
  const state: PlacementState = { kind, moduleId, modulesDir: options.modulesDir, moduleDir, linkPath, linkTarget, createLink, scopeDir, previousDir };

  const incoming = join(options.modulesDir, `.${moduleId}.incoming-${randomBytes(6).toString("hex")}`);
  const undo = () => undoPlacement(state);

  try {
    options.beforeChange?.(state);
    mkdirSync(options.modulesDir, { recursive: true });
    cpSync(options.stagingDir, incoming, { recursive: true, errorOnExist: true, force: false, dereference: false, verbatimSymlinks: true });
    if (previousDir !== null) {
      mkdirSync(dirname(previousDir), { recursive: true });
      renameSync(moduleDir, previousDir);
    }
    renameSync(incoming, moduleDir);
    if (createLink) {
      mkdirSync(dirname(linkPath), { recursive: true });
      symlinkSync(linkTarget, linkPath);
    }
  } catch (error) {
    undo();
    throw error;
  }
  return { moduleDir, linkPath, previousDir, state, undo };
}
