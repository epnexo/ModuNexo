import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { ManifestError, type ModuleManifest, validateManifest } from "@modunexo/sdk";
import semver from "semver";
import { RESERVED_PATHS, isReserved } from "../codegen/render.ts";
import { readMigrationFiles } from "../migrations.ts";

/** What the validator needs to know about the platform it is checking a package against. */
export interface PackageContext {
  /** The SDK version of this platform, which a manifest's `platform` range is checked against. */
  sdkVersion: string;
  /** The version of a package installed in the platform's own `node_modules`, or null when there is none. */
  installedVersion: (name: string) => string | null;
  /** Modules the platform knows, by id, with their installed version. */
  modules: ReadonlyMap<string, string>;
  /** The npm package name each known module was installed under, by module id. */
  modulePackages: ReadonlyMap<string, string>;
}

export interface PackageReview {
  id: string;
  version: string;
  name: string;
  packageName: string;
  platform: string;
  pages: { path: string; kind: string; permission?: string; public?: true }[];
  nav: { label: string; href: string; group?: string; permission?: string }[];
  permissions: { key: string; label: string }[];
  settings: { key: string; type: string; required: boolean; hasDefault: boolean }[];
  migrations: string[];
  runsHooks: boolean;
  dependencies: { name: string; range: string; installed: string | null }[];
  dependsOn: { id: string; range: string; status: "satisfied" | "missing" | "mismatch"; installed?: string }[];
  /** Names of the npm scripts the package declares. They are shown so they are seen, and never run. */
  scripts: string[];
}

export type PackageValidation =
  | { ok: true; manifest: ModuleManifest; review: PackageReview }
  | { ok: false; problems: string[] };

const MAX_JSON_BYTES = 1024 * 1024;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const SDK_PACKAGE = "@modunexo/sdk";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function readJson(root: string, name: string, problems: string[]): unknown {
  const path = join(root, name);
  if (!existsSync(path)) {
    problems.push(`${name} is missing`);
    return undefined;
  }
  const stat = lstatSync(path);
  if (!stat.isFile()) {
    problems.push(`${name} is not a file`);
    return undefined;
  }
  if (stat.size > MAX_JSON_BYTES) {
    problems.push(`${name} is larger than ${MAX_JSON_BYTES} bytes`);
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    problems.push(`${name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/** `entry` is a path relative to the package; this says what is wrong with it, or null. */
function fileProblem(root: string, what: string, entry: string): string | null {
  const absolute = resolve(root, entry);
  if (absolute !== root && !absolute.startsWith(root + sep)) return `${what} "${entry}" points outside the package`;
  if (!existsSync(absolute)) return `${what} "${entry}" does not exist`;
  if (!lstatSync(absolute).isFile()) return `${what} "${entry}" is not a file`;
  return null;
}

/**
 * Checks an unpacked package against the platform it would be installed on and describes it. Everything is read
 * as data: no file of the package is imported, required or executed, and nothing is written. Every problem found
 * is returned, so a package author fixes them in one go.
 */
export function validatePackageTree(root: string, context: PackageContext): PackageValidation {
  const problems: string[] = [];
  const base = resolve(root);

  const pkg = readJson(base, "package.json", problems);
  const raw = readJson(base, "manifest.json", problems);
  if (pkg !== undefined && !isRecord(pkg)) problems.push("package.json must be a JSON object");

  let manifest: ModuleManifest | undefined;
  if (raw !== undefined) {
    try {
      manifest = validateManifest(raw);
    } catch (error) {
      problems.push(`manifest.json is not a valid manifest: ${error instanceof ManifestError ? error.message : String(error)}`);
    }
  }
  if (!existsSync(join(base, "manifest.ts"))) problems.push("manifest.ts is missing (the platform loads it when the module is installed)");
  else if (!lstatSync(join(base, "manifest.ts")).isFile()) problems.push("manifest.ts is not a file");

  const packageJson = isRecord(pkg) ? pkg : undefined;
  let packageName = "";
  if (packageJson !== undefined) {
    const name = packageJson.name;
    if (typeof name !== "string" || name.length > 214 || !PACKAGE_NAME.test(name)) {
      problems.push(`package.json name ${JSON.stringify(name)} is not a valid package name`);
    } else {
      packageName = name;
      if (name.startsWith("@modunexo/")) problems.push(`package.json name "${name}" is in the platform's own @modunexo scope, which a module may not use`);
      else if (context.installedVersion(name) !== null && (manifest === undefined || context.modulePackages.get(manifest.id) !== name)) {
        problems.push(`package.json name "${name}" collides with the installed package "${name}"`);
      }
    }
    if (typeof packageJson.version !== "string" || semver.valid(packageJson.version) === null) {
      problems.push(`package.json version ${JSON.stringify(packageJson.version)} is not a valid semantic version`);
    } else if (manifest !== undefined && packageJson.version !== manifest.version) {
      problems.push(`package.json has version "${packageJson.version}" but the manifest says "${manifest.version}"`);
    }
  }

  const dependencies: PackageReview["dependencies"] = [];
  if (packageJson !== undefined) {
    const bundled = packageJson.bundledDependencies ?? packageJson.bundleDependencies;
    if (bundled !== undefined && bundled !== false && !(Array.isArray(bundled) && bundled.length === 0)) {
      problems.push("bundled dependencies are not accepted: a module cannot ship its own packages");
    }
    const wanted = new Map<string, unknown>();
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"] as const) {
      const section = packageJson[field];
      if (!isRecord(section)) continue;
      for (const [name, range] of Object.entries(section)) if (!wanted.has(name)) wanted.set(name, range);
    }
    for (const [name, range] of [...wanted].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (!PACKAGE_NAME.test(name) || name.length > 214) {
        problems.push(`dependency name ${JSON.stringify(name)} is not a valid package name`);
        continue;
      }
      if (typeof range !== "string" || semver.validRange(range) === null) {
        problems.push(`dependency "${name}" ${JSON.stringify(range)} is not a semver range (links, URLs, tags and workspace specifiers are not accepted)`);
        continue;
      }
      const installed = name === SDK_PACKAGE ? context.sdkVersion : context.installedVersion(name);
      if (installed === null) {
        problems.push(`dependency "${name}" is not installed in the platform (a module cannot bring packages of its own; add the library to the platform on purpose first)`);
        continue;
      }
      if (!semver.satisfies(installed, range, { includePrerelease: true })) {
        problems.push(`dependency "${name}" ${range} is not satisfied by the installed ${installed}`);
        continue;
      }
      dependencies.push({ name, range, installed });
    }
  }

  const migrations: string[] = [];
  let runsHooks = false;
  if (manifest !== undefined) {
    if (!semver.satisfies(context.sdkVersion, manifest.platform, { includePrerelease: true })) {
      problems.push(`the module needs platform ${manifest.platform}, this platform is ${context.sdkVersion}`);
    }
    (manifest.pages ?? []).forEach((page, index) => {
      const problem = fileProblem(base, `pages[${index}].entry`, page.entry);
      if (problem !== null) problems.push(problem);
      const reserved = isReserved(page.path, RESERVED_PATHS);
      if (reserved !== undefined) problems.push(`pages[${index}].path "${page.path}" is under "${reserved}", which is reserved for the shell`);
    });
    if (manifest.hooks !== undefined) {
      runsHooks = true;
      const problem = fileProblem(base, "hooks", manifest.hooks);
      if (problem !== null) problems.push(problem);
    }
    const dir = resolve(base, manifest.migrationsDir);
    if (dir !== base && !dir.startsWith(base + sep)) problems.push(`migrations folder "${manifest.migrationsDir}" points outside the package`);
    else if (!existsSync(dir) || !lstatSync(dir).isDirectory()) problems.push(`migrations folder "${manifest.migrationsDir}" does not exist`);
    else {
      try {
        migrations.push(...readMigrationFiles(dir).map((file) => file.filename));
      } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error));
      }
    }
  }

  if (problems.length > 0 || manifest === undefined) return { ok: false, problems: problems.length > 0 ? problems : ["the package could not be read"] };

  const dependsOn = Object.entries(manifest.dependsOn)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([id, range]): PackageReview["dependsOn"][number] => {
      const installed = context.modules.get(id);
      if (installed === undefined) return { id, range, status: "missing" };
      const satisfied = semver.validRange(range) !== null && semver.satisfies(installed, range, { includePrerelease: true });
      return { id, range, status: satisfied ? "satisfied" : "mismatch", installed };
    });

  const scripts = packageJson !== undefined && isRecord(packageJson.scripts) ? Object.keys(packageJson.scripts).sort() : [];

  return {
    ok: true,
    manifest,
    review: {
      id: manifest.id,
      version: manifest.version,
      name: manifest.name,
      packageName,
      platform: manifest.platform,
      pages: (manifest.pages ?? []).map((page) => ({
        path: page.path,
        kind: page.kind,
        ...(page.permission === undefined ? {} : { permission: page.permission }),
        ...(page.public === undefined ? {} : { public: true as const }),
      })),
      nav: manifest.nav.map((entry) => ({
        label: entry.label,
        href: entry.href,
        ...(entry.group === undefined ? {} : { group: entry.group }),
        ...(entry.permission === undefined ? {} : { permission: entry.permission }),
      })),
      permissions: (manifest.permissions ?? []).map((permission) => ({ key: permission.key, label: permission.label })),
      settings: (manifest.settings ?? []).map((setting) => ({ key: setting.key, type: setting.type, required: setting.required === true, hasDefault: setting.default !== undefined })),
      migrations,
      runsHooks,
      dependencies,
      dependsOn,
      scripts,
    },
  };
}
