import { valid, validRange } from "semver";

/** A navigation entry a module contributes to the web shell. */
export interface NavEntry {
  label: string;
  /** Absolute path inside the web shell, for example "/sample". */
  href: string;
  icon?: string;
  /** Sidebar group the entry belongs to. */
  group?: string;
  /** Sort position inside its group; lower comes first. */
  order?: number;
  /** Key of a permission declared in `permissions`; the entry is hidden without it. */
  permission?: string;
}

/** A route a module contributes. The codegen turns each page into a generated route file. */
export interface PageDeclaration {
  /**
   * Absolute, normalised path inside the web shell, for example "/sample/reports". Next.js dynamic
   * segments (`[id]`, `[...slug]`, `[[...slug]]`) are allowed.
   */
  path: string;
  /** Relative path (starting with "./") to the module file that implements the route. */
  entry: string;
  /** `page` renders UI; `route` is an HTTP handler. */
  kind: "page" | "route";
}

export type SettingType = "string" | "number" | "boolean" | "select" | "secret" | "path";

/** A setting the module declares; the platform stores and edits its value. */
export interface SettingDeclaration {
  /** Stable identifier, lowercase with digits, underscores and dots. */
  key: string;
  label: string;
  type: SettingType;
  /** Initial value; a `number` default must be finite. A `secret` must not declare one. */
  default?: string | number | boolean;
  required?: boolean;
  /** Allowed values; required and non-empty for `select`. */
  options?: string[];
  description?: string;
}

/** A permission key the module declares. */
export interface PermissionDeclaration {
  key: string;
  label: string;
}

/** The contract every module declares in its `manifest.ts` (manifest v2). */
export interface ModuleManifest {
  /** Unique kebab-case identifier. */
  id: string;
  /** Semantic version, `MAJOR.MINOR.PATCH` with an optional prerelease tag (`1.0.0-rc.1`). Build metadata (`+build.5`) is not allowed. */
  version: string;
  /** Human-readable name. */
  name: string;
  /** Semver range of the SDK versions this module supports. */
  platform: string;
  /** Modules that must be enabled first: module id to semver range. */
  dependsOn: Record<string, string>;
  /** Postgres schema owned by this module. */
  schema: string;
  /** Directory with `NNNN_name.sql` files. Relative paths resolve against the manifest folder. */
  migrationsDir: string;
  nav: NavEntry[];
  pages?: PageDeclaration[];
  settings?: SettingDeclaration[];
  permissions?: PermissionDeclaration[];
  /** Relative path (starting with "./") to a file exporting `onInstall`, `onEnable`, `onDisable`, `onUpgrade`, `onUninstall`. */
  hooks?: string;
}

/** Identity helper that gives module authors type checking on their manifest. */
export function defineModule(manifest: ModuleManifest): ModuleManifest {
  return manifest;
}

export class ManifestError extends Error {
  readonly problems: string[];

  constructor(label: string, problems: string[]) {
    super(`Invalid manifest ${label}:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ManifestError";
    this.problems = problems;
  }
}

const KEBAB_CASE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const SCHEMA_NAME = /^[a-z][a-z0-9_]{0,62}$/;
// "core" belongs to the platform itself.
const RESERVED_SCHEMAS = new Set(["public", "information_schema", "core"]);
const KNOWN_FIELDS = new Set([
  "id", "version", "name", "platform", "dependsOn", "schema", "migrationsDir", "nav", "pages", "settings", "permissions", "hooks",
]);
const KNOWN_NAV_FIELDS = new Set(["label", "href", "icon", "group", "order", "permission"]);
const KNOWN_PAGE_FIELDS = new Set(["path", "entry", "kind"]);
const KNOWN_SETTING_FIELDS = new Set(["key", "label", "type", "default", "required", "options", "description"]);
const KNOWN_PERMISSION_FIELDS = new Set(["key", "label"]);
const PAGE_KINDS = ["page", "route"];
const SETTING_TYPES = ["string", "number", "boolean", "select", "secret", "path"];
/** Lowercase dotted identifier, for example "api_key" or "reports.read". */
const KEY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
/** "./" followed by non-blank text with no ".." anywhere, which also rules out a ".." segment. */
const RELATIVE_ENTRY = /^\.\/(?!.*\.\.)\S+$/;
const ROUTE_SEGMENT = /^[^\s/?#]+$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSemverRange(value: unknown): value is string {
  return isNonEmptyString(value) && validRange(value) !== null;
}

function isRelativeEntry(value: unknown): value is string {
  return typeof value === "string" && RELATIVE_ENTRY.test(value);
}

/**
 * A route path is "/" or "/" followed by segments that are non-empty, free of whitespace, "?" and "#", and not
 * "." or "..". One trailing slash is tolerated.
 */
function isNormalisedRoutePath(value: string): boolean {
  if (value === "/") return true;
  const segments = value.slice(1).split("/");
  if (segments.length > 1 && segments[segments.length - 1] === "") segments.pop();
  return segments.every((segment) => ROUTE_SEGMENT.test(segment) && segment !== "." && segment !== "..");
}

/** Trailing slashes do not distinguish routes; the root stays "/". */
function routeKey(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function checkUnknownFields(item: Record<string, unknown>, known: Set<string>, where: string, problems: string[]): void {
  for (const key of Object.keys(item)) {
    if (!known.has(key)) problems.push(`${where} has unknown field "${key}"`);
  }
}

/** Run `check` on each object in `list`; report non-array and non-object shapes under `name`. */
function eachItem(
  list: unknown,
  name: string,
  problems: string[],
  check: (item: Record<string, unknown>, where: string, index: number) => void,
): void {
  if (!Array.isArray(list)) {
    problems.push(`${name} must be an array`);
    return;
  }
  list.forEach((item: unknown, index) => {
    if (!isPlainObject(item)) {
      problems.push(`${name}[${index}] must be an object`);
      return;
    }
    check(item, `${name}[${index}]`, index);
  });
}

function checkNav(nav: unknown, permissionKeys: Set<string>, problems: string[]): void {
  eachItem(nav, "nav", problems, (entry, where) => {
    checkUnknownFields(entry, KNOWN_NAV_FIELDS, where, problems);
    if (!isNonEmptyString(entry.label)) problems.push(`${where}.label must be a non-empty string`);
    if (typeof entry.href !== "string" || !entry.href.startsWith("/")) problems.push(`${where}.href must start with "/"`);
    if (entry.icon !== undefined && !isNonEmptyString(entry.icon)) problems.push(`${where}.icon must be a non-empty string when present`);
    if (entry.group !== undefined && !isNonEmptyString(entry.group)) problems.push(`${where}.group must be a non-empty string when present`);
    if (entry.order !== undefined && !(typeof entry.order === "number" && Number.isFinite(entry.order))) {
      problems.push(`${where}.order must be a finite number when present`);
    }
    if (entry.permission !== undefined) {
      if (typeof entry.permission !== "string" || !permissionKeys.has(entry.permission)) {
        problems.push(`${where}.permission "${String(entry.permission)}" is not a declared permission`);
      }
    }
  });
}

function checkPages(pages: unknown, problems: string[]): void {
  const seen = new Set<string>();
  eachItem(pages, "pages", problems, (page, where) => {
    checkUnknownFields(page, KNOWN_PAGE_FIELDS, where, problems);
    if (typeof page.path !== "string" || !page.path.startsWith("/")) {
      problems.push(`${where}.path must start with "/"`);
    } else if (!isNormalisedRoutePath(page.path)) {
      problems.push(`${where}.path must be a normalised route path (single slashes, no ".", ".." or empty segment, no whitespace, "?" or "#")`);
    } else if (seen.has(routeKey(page.path))) {
      problems.push(`${where}.path "${page.path}" is duplicated`);
    } else {
      seen.add(routeKey(page.path));
    }
    if (!isRelativeEntry(page.entry)) problems.push(`${where}.entry must be a relative path starting with "./"`);
    if (typeof page.kind !== "string" || !PAGE_KINDS.includes(page.kind)) problems.push(`${where}.kind must be "page" or "route"`);
  });
}

function checkSettingDefault(setting: Record<string, unknown>, where: string, problems: string[]): void {
  const { type, default: value } = setting;
  if (value === undefined) return;
  if (type === "secret") problems.push(`${where}.default is not allowed for type "secret"`);
  else if (type === "number" && !(typeof value === "number" && Number.isFinite(value))) problems.push(`${where}.default must be a finite number`);
  else if (type === "boolean" && typeof value !== "boolean") problems.push(`${where}.default must be a boolean`);
  else if ((type === "string" || type === "path") && typeof value !== "string") problems.push(`${where}.default must be a string`);
  else if (type === "select" && Array.isArray(setting.options) && !setting.options.includes(value)) {
    problems.push(`${where}.default must be one of the options`);
  }
}

function checkSettings(settings: unknown, problems: string[]): void {
  const seen = new Set<string>();
  eachItem(settings, "settings", problems, (setting, where) => {
    checkUnknownFields(setting, KNOWN_SETTING_FIELDS, where, problems);
    if (typeof setting.key !== "string" || !KEY.test(setting.key)) {
      problems.push(`${where}.key must be a stable identifier (lowercase a-z, 0-9, _ and dot-separated segments)`);
    } else if (seen.has(setting.key)) {
      problems.push(`${where}.key "${setting.key}" is duplicated`);
    } else {
      seen.add(setting.key);
    }
    if (!isNonEmptyString(setting.label)) problems.push(`${where}.label must be a non-empty string`);
    if (typeof setting.type !== "string" || !SETTING_TYPES.includes(setting.type)) {
      problems.push(`${where}.type must be one of ${SETTING_TYPES.join(", ")}`);
    }
    if (setting.required !== undefined && typeof setting.required !== "boolean") problems.push(`${where}.required must be a boolean when present`);
    if (setting.description !== undefined && !isNonEmptyString(setting.description)) {
      problems.push(`${where}.description must be a non-empty string when present`);
    }
    if (setting.type === "select") {
      if (!Array.isArray(setting.options) || setting.options.length === 0 || !setting.options.every(isNonEmptyString)) {
        problems.push(`${where}.options must be a non-empty array of non-empty strings for type "select"`);
      }
    } else if (setting.options !== undefined) {
      problems.push(`${where}.options is only allowed for type "select"`);
    }
    checkSettingDefault(setting, where, problems);
  });
}

function checkPermissions(permissions: unknown, problems: string[]): Set<string> {
  const seen = new Set<string>();
  eachItem(permissions, "permissions", problems, (permission, where) => {
    checkUnknownFields(permission, KNOWN_PERMISSION_FIELDS, where, problems);
    if (typeof permission.key !== "string" || !KEY.test(permission.key)) {
      problems.push(`${where}.key must be a stable identifier (lowercase a-z, 0-9, _ and dot-separated segments)`);
    } else if (seen.has(permission.key)) {
      problems.push(`${where}.key "${permission.key}" is duplicated`);
    } else {
      seen.add(permission.key);
    }
    if (!isNonEmptyString(permission.label)) problems.push(`${where}.label must be a non-empty string`);
  });
  return seen;
}

export interface ValidateOptions {
  /**
   * Admit the schema name "core", which is reserved for the platform, and only for a manifest whose id is
   * also "core". Only the platform's own core manifest passes this; every other reserved name stays rejected.
   */
  allowCoreSchema?: boolean;
}

/** Validate untrusted input and return it as a typed manifest. Throws `ManifestError` listing every problem. */
export function validateManifest(input: unknown, options: ValidateOptions = {}): ModuleManifest {
  if (!isPlainObject(input)) {
    throw new ManifestError("(unknown)", ["manifest must be an object"]);
  }
  const raw = input;
  const problems: string[] = [];

  for (const key of Object.keys(raw)) {
    if (!KNOWN_FIELDS.has(key)) problems.push(`unknown field "${key}"`);
  }

  if (typeof raw.id !== "string" || !KEBAB_CASE.test(raw.id)) problems.push("id must be kebab-case");
  if (typeof raw.version !== "string" || valid(raw.version) !== raw.version) problems.push("version must be semver MAJOR.MINOR.PATCH with an optional prerelease tag and no build metadata");
  if (!isNonEmptyString(raw.name)) problems.push("name must be a non-empty string");
  if (!isSemverRange(raw.platform)) problems.push("platform must be a valid semver range");

  if (
    typeof raw.schema !== "string" ||
    !SCHEMA_NAME.test(raw.schema) ||
    (RESERVED_SCHEMAS.has(raw.schema) && !(options.allowCoreSchema === true && raw.schema === "core" && raw.id === "core")) ||
    raw.schema.startsWith("pg_")
  ) {
    problems.push("schema must be a lowercase Postgres identifier (a-z, 0-9, _), at most 63 characters, and not reserved");
  }

  if (!isNonEmptyString(raw.migrationsDir)) problems.push("migrationsDir must be a non-empty string");

  if (!isPlainObject(raw.dependsOn)) {
    problems.push("dependsOn must be an object mapping module ids to semver ranges");
  } else {
    for (const [dep, range] of Object.entries(raw.dependsOn)) {
      if (!KEBAB_CASE.test(dep)) problems.push(`dependsOn key "${dep}" must be a kebab-case module id`);
      if (!isSemverRange(range)) problems.push(`dependsOn.${dep} must be a valid semver range`);
    }
    if (typeof raw.id === "string" && Object.hasOwn(raw.dependsOn, raw.id)) problems.push("a module cannot depend on itself");
  }

  const permissionKeys = raw.permissions === undefined ? new Set<string>() : checkPermissions(raw.permissions, problems);
  checkNav(raw.nav, permissionKeys, problems);
  if (raw.pages !== undefined) checkPages(raw.pages, problems);
  if (raw.settings !== undefined) checkSettings(raw.settings, problems);
  if (raw.hooks !== undefined && !isRelativeEntry(raw.hooks)) problems.push('hooks must be a relative path starting with "./"');

  if (problems.length > 0) {
    const label = typeof raw.id === "string" ? `"${raw.id}"` : "(unknown id)";
    throw new ManifestError(label, problems);
  }
  return raw as unknown as ModuleManifest;
}
