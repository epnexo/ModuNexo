/**
 * The tools the MCP server offers. Each one is a fixed shape that becomes the argv of one CLI command, so an agent can
 * only do what is listed here, with values checked against the field it was declared with. Nothing that handles a
 * password, prints a secret, drops data or opens the platform (admin or user create, settings set, tokens create,
 * auth disable, uninstall, install, files delete) is offered, whatever the write switch says.
 */

/** A plain name: it cannot start with "-", so a value can never become a CLI option. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const MAX_PAYLOAD_BYTES = 64 * 1024;

export type Field =
  | { kind: "name"; description: string }
  | { kind: "int"; min: number; max: number; description: string }
  | { kind: "enum"; values: readonly string[]; description: string }
  | { kind: "object"; description: string };

export type Args = Record<string, unknown>;

export interface ToolDef {
  name: string;
  description: string;
  /** A write tool is hidden and refused unless the server was started with writes on. */
  write: boolean;
  fields: Record<string, Field>;
  required?: readonly string[];
  /** The CLI argv for validated arguments. Absent for a tool that composes several commands itself. */
  argv?: (args: Args) => string[];
}

export class ArgumentError extends Error {}

/** What the server never offers, whatever the write switch says. The settings screen shows this same list. */
export const NEVER_OFFERED: readonly { label: string; reason: string }[] = [
  { label: "admin create / user create", reason: "They handle passwords, which never travel through an agent." },
  { label: "settings set", reason: "It writes secrets such as API keys." },
  { label: "tokens create", reason: "The token is printed once and would end up in the conversation." },
  { label: "auth disable", reason: "It opens the platform to the local network without a sign-in." },
  { label: "modules install / uninstall / purge", reason: "Installing runs code with database access; purging drops data for good." },
  { label: "files delete", reason: "It removes stored files and their bytes irreversibly." },
];

const JOB_STATUSES = ["queued", "running", "succeeded", "dead", "cancelled"] as const;

const moduleId = (what = "The module id"): Field => ({ kind: "name", description: `${what} (letters, digits and . _ : -).` });
const limit = (max: number): Field => ({ kind: "int", min: 1, max, description: `How many rows at most (1 to ${max}).` });

/** The arguments as validated strings, or an ArgumentError naming the first problem. Unknown fields are refused. */
export function checkArguments(tool: ToolDef, raw: unknown): Args {
  const args = raw === undefined ? {} : raw;
  if (typeof args !== "object" || args === null || Array.isArray(args)) throw new ArgumentError("the arguments must be an object");
  const given = args as Args;
  for (const key of Object.keys(given)) if (!(key in tool.fields)) throw new ArgumentError(`unknown argument "${key}"`);
  for (const key of tool.required ?? []) if (given[key] === undefined) throw new ArgumentError(`"${key}" is required`);
  const clean: Args = {};
  for (const [key, field] of Object.entries(tool.fields)) {
    const value = given[key];
    if (value === undefined) continue;
    clean[key] = checkField(key, field, value);
  }
  return clean;
}

function checkField(key: string, field: Field, value: unknown): string | number | object {
  switch (field.kind) {
    case "name": {
      const text = typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : value;
      if (typeof text !== "string" || !NAME.test(text)) throw new ArgumentError(`"${key}" must be a plain name (letters, digits and . _ : -, not starting with "-", at most 100 characters)`);
      return text;
    }
    case "int":
      if (typeof value !== "number" || !Number.isInteger(value) || value < field.min || value > field.max) throw new ArgumentError(`"${key}" must be a whole number from ${field.min} to ${field.max}`);
      return value;
    case "enum":
      if (typeof value !== "string" || !field.values.includes(value)) throw new ArgumentError(`"${key}" must be one of ${field.values.join(", ")}`);
      return value;
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ArgumentError(`"${key}" must be a JSON object`);
      if (Buffer.byteLength(JSON.stringify(value)) > MAX_PAYLOAD_BYTES) throw new ArgumentError(`"${key}" is over ${MAX_PAYLOAD_BYTES} bytes`);
      return value;
    }
  }
}

/** The JSON Schema an MCP client shows the model, generated from the same fields the validation uses. */
export function inputSchema(tool: ToolDef): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(tool.fields)) {
    if (field.kind === "name") properties[key] = { type: "string", pattern: NAME.source, maxLength: 100, description: field.description };
    else if (field.kind === "int") properties[key] = { type: "integer", minimum: field.min, maximum: field.max, description: field.description };
    else if (field.kind === "enum") properties[key] = { type: "string", enum: [...field.values], description: field.description };
    else properties[key] = { type: "object", description: field.description };
  }
  return { type: "object", properties, required: [...(tool.required ?? [])], additionalProperties: false };
}

const text = (args: Args, key: string) => args[key] as string;
const optional = (args: Args, key: string, flag: string, render: (value: never) => string = (v) => String(v)) =>
  args[key] === undefined ? [] : [flag, render(args[key] as never)];

const read = (name: string, description: string, fields: Record<string, Field>, argv: (args: Args) => string[]): ToolDef => ({ name, description, write: false, fields, argv });

export const TOOLS: readonly ToolDef[] = [
  read("modules_list", "List every known module with its state (available, enabled, disabled) and flags such as upgrade-pending or orphaned.", {}, () => ["modules", "list", "--json"]),
  read("users_list", "List the platform users with their role (admin or operator) and whether they are banned. Never shows passwords.", {}, () => ["user", "list", "--json"]),
  read("settings_list", "List the platform appearance settings, or a module's declared settings when a module is given. Secret values are not shown.", { module: moduleId() }, (a) => ["settings", "list", ...optional(a, "module", "--module"), "--json"]),
  read("tokens_list", "List service tokens with their state (never the token itself), optionally for one module.", { module: moduleId() }, (a) => ["tokens", "list", ...(a.module === undefined ? [] : [text(a, "module")]), "--json"]),
  read(
    "jobs_list",
    "List background jobs with their state and last error, optionally for one module or status. Payloads are not included.",
    { module: moduleId(), status: { kind: "enum", values: JOB_STATUSES, description: "Only jobs in this state." } },
    (a) => ["jobs", "list", ...(a.module === undefined ? [] : [text(a, "module")]), ...optional(a, "status", "--status")],
  ),
  read(
    "events_list",
    "List the newest events, optionally for one module or type. Payloads are not included.",
    { module: moduleId(), type: moduleId("The event type"), limit: limit(200) },
    (a) => ["events", "list", ...(a.module === undefined ? [] : [text(a, "module")]), ...optional(a, "type", "--type"), ...optional(a, "limit", "--limit")],
  ),
  read(
    "files_list",
    "List the newest stored files (name, type, size). The content is never returned.",
    { module: moduleId(), limit: limit(200) },
    (a) => ["files", "list", ...(a.module === undefined ? [] : [text(a, "module")]), ...optional(a, "limit", "--limit")],
  ),
  read("auth_status", "Say whether the platform asks for a sign-in (required) or serves local requests without one (disabled).", {}, () => ["auth", "status"]),
  read("llm_probe", "Ask the LLM provider a module is configured with for its models, to check the connection. Never prints the key.", { module: moduleId() }, (a) => ["llm", "probe", text(a, "module"), "--json"]),
  { name: "validate", description: "Check the platform in one call: module flags (pending upgrades, orphans, invalid versions), the sign-in mode and that an administrator exists. Returns a report with findings.", write: false, fields: {} },

  { name: "modules_enable", description: "Enable a disabled module. Does not rebuild the web app.", write: true, fields: { id: moduleId() }, required: ["id"], argv: (a) => ["modules", "enable", text(a, "id")] },
  { name: "modules_disable", description: "Disable an enabled module. Its data is kept. Does not rebuild the web app.", write: true, fields: { id: moduleId() }, required: ["id"], argv: (a) => ["modules", "disable", text(a, "id")] },
  {
    name: "jobs_enqueue",
    description: "Queue a background job a module declared, with an optional JSON payload, delay and dedupe key.",
    write: true,
    fields: {
      module: moduleId(),
      job: moduleId("The job name"),
      payload: { kind: "object", description: "The job payload, a JSON object." },
      delaySeconds: { kind: "int", min: 0, max: 31_536_000, description: "Wait this many seconds before it may run." },
      dedupeKey: moduleId("A key that stops the same job being queued twice"),
    },
    required: ["module", "job"],
    argv: (a) => ["jobs", "enqueue", text(a, "module"), text(a, "job"), ...optional(a, "payload", "--payload", (v: object) => JSON.stringify(v)), ...optional(a, "delaySeconds", "--delay-seconds"), ...optional(a, "dedupeKey", "--dedupe-key")],
  },
  { name: "jobs_retry", description: "Retry a dead job from its first attempt.", write: true, fields: { id: moduleId("The job id") }, required: ["id"], argv: (a) => ["jobs", "retry", text(a, "id")] },
  { name: "jobs_cancel", description: "Cancel a queued job.", write: true, fields: { id: moduleId("The job id") }, required: ["id"], argv: (a) => ["jobs", "cancel", text(a, "id")] },
  {
    name: "events_publish",
    description: "Publish an event a module declared; the jobs subscribed to it are queued.",
    write: true,
    fields: { module: moduleId(), event: moduleId("The event type"), payload: { kind: "object", description: "The event payload, a JSON object." } },
    required: ["module", "event"],
    argv: (a) => ["events", "publish", text(a, "module"), text(a, "event"), ...optional(a, "payload", "--payload", (v: object) => JSON.stringify(v))],
  },
];
