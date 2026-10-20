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

/** Next.js `dynamic` segment config. It must be written literally in a route file, so the manifest declares it. */
export type PageDynamic = "auto" | "force-dynamic" | "force-static" | "error";

/** HTTP methods a `route` entry can export. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

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
  /**
   * Next.js `dynamic` segment config for this route. Next.js reads it from the route file itself, so the codegen
   * writes it there literally; it cannot be re-exported from the module. Omitted means Next.js's default.
   */
  dynamic?: PageDynamic;
  /** `route` only: the handlers the entry exports, re-exported by the generated route file. Default `["GET"]`. */
  methods?: HttpMethod[];
  /**
   * Key of a permission declared in `permissions`. The shell refuses the route to anyone who does not hold it,
   * for the page and for the handler alike; it is enforced at the gate, not only by hiding a link.
   */
  permission?: string;
  /**
   * `route` only: opens the route to callers without a session, for inbound webhooks. It must declare the signature
   * check, lives under `/hooks/<module-id>/`, declares its `methods` explicitly (none of GET, HEAD or OPTIONS) and
   * cannot be combined with `permission`. The shell verifies the signature before the module handler runs.
   */
  public?: PublicRouteDeclaration;
  /**
   * `route` only: Key of a scope declared in `scopes`. The route answers without a session to a request that carries
   * `Authorization: Bearer <token>` for a service token of this module that holds the scope. It lives under
   * `/svc/<module-id>/` and cannot be combined with `public` or `permission`.
   */
  scope?: string;
}

/** How the shell authenticates a public route: an HMAC-SHA256 of the raw body, keyed by a `secret` setting. */
export interface SignatureDeclaration {
  /** Key of a setting of type "secret" declared by this module; it holds the shared secret. */
  secret: string;
  /** Request header carrying the signature. */
  header: string;
  /** How the digest is written in the header. Default "hex". */
  encoding?: "hex" | "base64";
  /** Text that precedes the digest in the header, for example "sha256=". */
  prefix?: string;
  /**
   * Header with the Unix time in seconds. When set, the signed text is `<timestamp>.<body>` and a request outside
   * `toleranceSeconds` of the server clock is refused, which closes the replay window.
   */
  timestampHeader?: string;
  /** Accepted clock distance in seconds, 1 to 3600. Only with `timestampHeader`. Default 300. */
  toleranceSeconds?: number;
}

export interface PublicRouteDeclaration {
  signature: SignatureDeclaration;
  /** Requests accepted per minute from one client; the rest answer 429. 1 to 10000, default 60. */
  ratePerMinute?: number;
  /** Largest accepted body in bytes; a larger one answers 413. 1 to 10485760, default 1048576. */
  maxBodyBytes?: number;
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

/** A scope the module declares; a service token is issued for some of a module's scopes. */
export interface ScopeDeclaration {
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
  /** Scopes a service token can hold for this module; a route names the one it requires with `scope`. */
  scopes?: ScopeDeclaration[];
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
  "id", "version", "name", "platform", "dependsOn", "schema", "migrationsDir", "nav", "pages", "settings", "permissions", "scopes", "hooks",
]);
const KNOWN_NAV_FIELDS = new Set(["label", "href", "icon", "group", "order", "permission"]);
const KNOWN_PAGE_FIELDS = new Set(["path", "entry", "kind", "dynamic", "methods", "permission", "public", "scope"]);
const KNOWN_PUBLIC_FIELDS = new Set(["signature", "ratePerMinute", "maxBodyBytes"]);
const KNOWN_SIGNATURE_FIELDS = new Set(["secret", "header", "encoding", "prefix", "timestampHeader", "toleranceSeconds"]);
const SIGNATURE_ENCODINGS = ["hex", "base64"];
/** Methods that carry no body to sign, so they cannot be public. */
const BODYLESS_METHODS = ["GET", "HEAD", "OPTIONS"];
const HEADER_NAME = /^[A-Za-z0-9-]+$/;
const MAX_BODY_LIMIT = 10 * 1024 * 1024;
const KNOWN_SETTING_FIELDS = new Set(["key", "label", "type", "default", "required", "options", "description"]);
const KNOWN_PERMISSION_FIELDS = new Set(["key", "label"]);
const KNOWN_SCOPE_FIELDS = new Set(["key", "label"]);
const PAGE_KINDS = ["page", "route"];
const PAGE_DYNAMIC_MODES = ["auto", "force-dynamic", "force-static", "error"];
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const SETTING_TYPES = ["string", "number", "boolean", "select", "secret", "path"];
/** Lowercase dotted identifier, for example "api_key" or "reports.read". */
const KEY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
/** "./" followed by non-blank text with no ".." anywhere, which also rules out a ".." segment. */
const RELATIVE_ENTRY = /^\.\/(?!.*\.\.)\S+$/;
const ROUTE_SEGMENT = /^[^\s/?#]+$/;

const DYNAMIC_ROUTE_SEGMENT = /^(?:\[[A-Za-z][A-Za-z0-9_]*\]|\[\.\.\.[A-Za-z][A-Za-z0-9_]*\]|\[\[\.\.\.[A-Za-z][A-Za-z0-9_]*\]\])$/;

/** A Next.js dynamic segment with balanced brackets: `[name]`, `[...name]` or `[[...name]]`, nothing around it. */
export function isDynamicRouteSegment(segment: string): boolean {
  return DYNAMIC_ROUTE_SEGMENT.test(segment);
}

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
 * "." or "..". A segment that contains a bracket must be a whole dynamic segment (see `isDynamicRouteSegment`).
 * One trailing slash is tolerated.
 */
function isNormalisedRoutePath(value: string): boolean {
  if (value === "/") return true;
  const segments = value.slice(1).split("/");
  if (segments.length > 1 && segments[segments.length - 1] === "") segments.pop();
  return segments.every((segment) => ROUTE_SEGMENT.test(segment) && segment !== "." && segment !== ".." && (!/[[\]]/.test(segment) || isDynamicRouteSegment(segment)));
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
    if (entry.permission !== undefined && entry.href === "/") {
      problems.push(`${where}.permission cannot be combined with href "/": it would cover the whole shell`);
    }
    if (entry.permission !== undefined) {
      if (typeof entry.permission !== "string" || !permissionKeys.has(entry.permission)) {
        problems.push(`${where}.permission "${String(entry.permission)}" is not a declared permission`);
      }
    }
  });
}

function isIntegerInRange(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function checkSignature(signature: unknown, secretKeys: Set<string>, where: string, problems: string[]): void {
  if (signature === undefined) {
    problems.push(`${where}.signature is required: a public route must declare how its callers are authenticated`);
    return;
  }
  if (!isPlainObject(signature)) {
    problems.push(`${where}.signature must be an object`);
    return;
  }
  const at = `${where}.signature`;
  checkUnknownFields(signature, KNOWN_SIGNATURE_FIELDS, at, problems);
  if (typeof signature.secret !== "string" || !secretKeys.has(signature.secret)) {
    problems.push(`${at}.secret "${String(signature.secret)}" must name a declared setting of type "secret"`);
  }
  if (typeof signature.header !== "string" || !HEADER_NAME.test(signature.header)) {
    problems.push(`${at}.header must be a header name (letters, digits and "-")`);
  }
  if (signature.encoding !== undefined && (typeof signature.encoding !== "string" || !SIGNATURE_ENCODINGS.includes(signature.encoding))) {
    problems.push(`${at}.encoding must be one of ${SIGNATURE_ENCODINGS.join(", ")}`);
  }
  if (signature.prefix !== undefined && !isNonEmptyString(signature.prefix)) {
    problems.push(`${at}.prefix must be a non-empty string when present`);
  }
  if (signature.timestampHeader !== undefined && (typeof signature.timestampHeader !== "string" || !HEADER_NAME.test(signature.timestampHeader))) {
    problems.push(`${at}.timestampHeader must be a header name (letters, digits and "-")`);
  }
  if (signature.toleranceSeconds !== undefined) {
    if (signature.timestampHeader === undefined) problems.push(`${at}.toleranceSeconds needs a timestampHeader`);
    else if (!isIntegerInRange(signature.toleranceSeconds, 1, 3600)) problems.push(`${at}.toleranceSeconds must be an integer from 1 to 3600`);
  }
}

function checkPublic(page: Record<string, unknown>, where: string, ctx: PageContext, problems: string[]): void {
  const declared = page.public;
  if (!isPlainObject(declared)) {
    problems.push(`${where}.public must be an object with a signature`);
    return;
  }
  if (page.kind !== "route") problems.push(`${where}.public is only allowed for kind "route"`);
  if (page.permission !== undefined) problems.push(`${where}.public cannot be combined with permission: a public route has no session`);
  if (typeof page.path === "string" && ctx.moduleId !== undefined) {
    const prefix = `/hooks/${ctx.moduleId}/`;
    if (!page.path.startsWith(prefix) || page.path.length === prefix.length) {
      problems.push(`${where}.path "${page.path}" must sit under ${prefix} to be public`);
    }
  }
  if (page.kind === "route") {
    if (!Array.isArray(page.methods)) {
      problems.push(`${where}.methods must be declared for a public route`);
    } else {
      for (const method of page.methods) {
        if (BODYLESS_METHODS.includes(method as string)) problems.push(`${where}.methods "${String(method)}" cannot be public: there is no body to sign`);
      }
    }
  }
  checkUnknownFields(declared, KNOWN_PUBLIC_FIELDS, `${where}.public`, problems);
  checkSignature(declared.signature, ctx.secretKeys, `${where}.public`, problems);
  if (declared.ratePerMinute !== undefined && !isIntegerInRange(declared.ratePerMinute, 1, 10000)) {
    problems.push(`${where}.public.ratePerMinute must be an integer from 1 to 10000`);
  }
  if (declared.maxBodyBytes !== undefined && !isIntegerInRange(declared.maxBodyBytes, 1, MAX_BODY_LIMIT)) {
    problems.push(`${where}.public.maxBodyBytes must be an integer from 1 to ${MAX_BODY_LIMIT}`);
  }
}

function checkScopeRoute(page: Record<string, unknown>, where: string, ctx: PageContext, problems: string[]): void {
  if (typeof page.scope !== "string" || !ctx.scopeKeys.has(page.scope)) {
    problems.push(`${where}.scope "${String(page.scope)}" is not a declared scope`);
  }
  if (page.kind !== "route") problems.push(`${where}.scope is only allowed for kind "route"`);
  if (page.permission !== undefined) problems.push(`${where}.scope cannot be combined with permission: a scoped route has no session`);
  if (page.public !== undefined) problems.push(`${where}.scope cannot be combined with public: a route is signed or token-guarded, not both`);
  if (typeof page.path === "string" && ctx.moduleId !== undefined) {
    const prefix = `/svc/${ctx.moduleId}/`;
    if (!page.path.startsWith(prefix) || page.path.length === prefix.length) {
      problems.push(`${where}.path "${page.path}" must sit under ${prefix} to be scoped`);
    }
  }
}

/** What `checkPages` needs to know about the rest of the manifest. */
interface PageContext {
  moduleId: string | undefined;
  /** Keys of the settings declared with type "secret". */
  secretKeys: Set<string>;
  /** Keys of the declared scopes. */
  scopeKeys: Set<string>;
}

function secretSettingKeys(settings: unknown): Set<string> {
  const keys = new Set<string>();
  if (!Array.isArray(settings)) return keys;
  for (const setting of settings) {
    if (isPlainObject(setting) && setting.type === "secret" && typeof setting.key === "string") keys.add(setting.key);
  }
  return keys;
}

function checkPages(pages: unknown, permissionKeys: Set<string>, ctx: PageContext, problems: string[]): void {
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
    if (page.dynamic !== undefined && (typeof page.dynamic !== "string" || !PAGE_DYNAMIC_MODES.includes(page.dynamic))) {
      problems.push(`${where}.dynamic must be one of ${PAGE_DYNAMIC_MODES.join(", ")}`);
    }
    if (page.permission !== undefined && (typeof page.permission !== "string" || !permissionKeys.has(page.permission))) {
      problems.push(`${where}.permission "${String(page.permission)}" is not a declared permission${typeof page.path === "string" ? ` (page "${page.path}")` : ""}`);
    }
    if (page.methods !== undefined) {
      if (page.kind !== "route") {
        problems.push(`${where}.methods is only allowed for kind "route"`);
      } else if (!Array.isArray(page.methods) || page.methods.length === 0 || !page.methods.every((m) => typeof m === "string" && HTTP_METHODS.includes(m)) || new Set(page.methods).size !== page.methods.length) {
        problems.push(`${where}.methods must be a non-empty array of distinct HTTP methods (${HTTP_METHODS.join(", ")})`);
      }
    }
    if (page.public !== undefined) checkPublic(page, where, ctx, problems);
    else if (typeof page.path === "string" && (page.path === "/hooks" || page.path.startsWith("/hooks/"))) {
      problems.push(`${where}.path "${page.path}" is under /hooks, which is reserved for public routes`);
    }
    if (page.scope !== undefined) checkScopeRoute(page, where, ctx, problems);
    else if (typeof page.path === "string" && (page.path === "/svc" || page.path.startsWith("/svc/"))) {
      problems.push(`${where}.path "${page.path}" is under /svc, which is reserved for scoped routes`);
    }
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

function checkScopes(scopes: unknown, problems: string[]): Set<string> {
  const seen = new Set<string>();
  eachItem(scopes, "scopes", problems, (scope, where) => {
    checkUnknownFields(scope, KNOWN_SCOPE_FIELDS, where, problems);
    if (typeof scope.key !== "string" || !KEY.test(scope.key)) {
      problems.push(`${where}.key must be a stable identifier (lowercase a-z, 0-9, _ and dot-separated segments)`);
    } else if (seen.has(scope.key)) {
      problems.push(`${where}.key "${scope.key}" is duplicated`);
    } else {
      seen.add(scope.key);
    }
    if (!isNonEmptyString(scope.label)) problems.push(`${where}.label must be a non-empty string`);
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
  const scopeKeys = raw.scopes === undefined ? new Set<string>() : checkScopes(raw.scopes, problems);
  checkNav(raw.nav, permissionKeys, problems);
  if (raw.pages !== undefined) {
    const ctx: PageContext = { moduleId: typeof raw.id === "string" ? raw.id : undefined, secretKeys: secretSettingKeys(raw.settings), scopeKeys };
    checkPages(raw.pages, permissionKeys, ctx, problems);
  }
  if (raw.settings !== undefined) checkSettings(raw.settings, problems);
  if (raw.hooks !== undefined && !isRelativeEntry(raw.hooks)) problems.push('hooks must be a relative path starting with "./"');

  if (problems.length > 0) {
    const label = typeof raw.id === "string" ? `"${raw.id}"` : "(unknown id)";
    throw new ManifestError(label, problems);
  }
  return raw as unknown as ModuleManifest;
}
