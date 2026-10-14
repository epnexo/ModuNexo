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
}

export interface Placement {
  moduleDir: string;
  linkPath: string;
  /** Where the replaced version was moved to; null for an install. */
  previousDir: string | null;
  /** Puts everything back as it was before `placePackage`. Safe to call once. */
  undo: () => void;
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
  const target = relative(dirname(linkPath), moduleDir);
  const exists = existsSync(moduleDir) || (() => { try { lstatSync(moduleDir); return true; } catch { return false; } })();

  let previousDir: string | null = null;
  if (kind === "install") {
    if (exists) throw new PlacementRefusedError(`modules/${moduleId} already exists; an installed module is changed by an upgrade`);
  } else {
    if (!exists) throw new PlacementRefusedError(`modules/${moduleId} has no folder to upgrade`);
    if (options.previousVersion === undefined) throw new PlacementRefusedError("an upgrade needs the version it replaces");
    const current = packageNameOf(moduleDir);
    if (current !== packageName) throw new PlacementRefusedError(`the package name changed from ${JSON.stringify(current)} to "${packageName}"; an upgrade keeps its name`);
    previousDir = join(options.dataDir, "previous", `${moduleId}-${options.previousVersion}`);
    if (existsSync(previousDir)) throw new PlacementRefusedError(`${previousDir} already exists`);
  }

  let linkCreated = false;
  let scopeCreated: string | null = null;
  if (kind === "install") {
    let present = false;
    try {
      lstatSync(linkPath);
      present = true;
    } catch {
      present = false;
    }
    if (present) {
      const sameLink = lstatSync(linkPath).isSymbolicLink() && readlinkSync(linkPath) === target;
      if (!sameLink) throw new PlacementRefusedError(`node_modules/${packageName} is already taken by something else`);
    }
  }

  const incoming = join(options.modulesDir, `.${moduleId}.incoming-${randomBytes(6).toString("hex")}`);
  let movedPrevious = false;
  let placed = false;
  const undo = () => {
    if (placed) rmSync(moduleDir, { recursive: true, force: true });
    if (movedPrevious && previousDir !== null) {
      renameSync(previousDir, moduleDir);
    }
    if (linkCreated) rmSync(linkPath, { force: true });
    if (scopeCreated !== null) {
      try {
        if (readdirSync(scopeCreated).length === 0) rmdirSync(scopeCreated);
      } catch {
        // Already gone or not empty: nothing of ours to remove.
      }
    }
    rmSync(incoming, { recursive: true, force: true });
  };

  try {
    mkdirSync(options.modulesDir, { recursive: true });
    cpSync(options.stagingDir, incoming, { recursive: true, errorOnExist: true, force: false, dereference: false, verbatimSymlinks: true });
    if (previousDir !== null) {
      mkdirSync(dirname(previousDir), { recursive: true });
      renameSync(moduleDir, previousDir);
      movedPrevious = true;
    }
    renameSync(incoming, moduleDir);
    placed = true;
    if (kind === "install") {
      const scope = packageName.startsWith("@") ? dirname(linkPath) : null;
      if (scope !== null && !existsSync(scope)) {
        mkdirSync(scope, { recursive: true });
        scopeCreated = scope;
      }
      mkdirSync(dirname(linkPath), { recursive: true });
      if (!existsSync(linkPath)) {
        symlinkSync(target, linkPath);
        linkCreated = true;
      }
    }
  } catch (error) {
    undo();
    throw error;
  }
  return { moduleDir, linkPath, previousDir, undo };
}
