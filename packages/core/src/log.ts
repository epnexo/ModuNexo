/**
 * One line per event, for whoever reads the server's output. In production (or with `LOG_FORMAT=json`) a line is a
 * JSON object that a log collector can parse; otherwise it is a readable line. The module touches nothing but
 * `console` and `process.env`, so it also runs in the web app's request gate.
 *
 * What it guarantees: a field named like a secret (password, token, cookie, authorization, key, session...) is
 * replaced by "[redacted]"; an Error is reduced to its name and message, never its stack; a long value is cut; a
 * value that cannot be serialised cannot break the line; and a field cannot overwrite the time, level or event.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFormat = "json" | "text";
export type LogFields = Record<string, unknown>;
export type LogSink = (line: string, level: LogLevel) => void;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export interface LoggerOptions {
  format?: LogFormat;
  sink?: LogSink;
  now?: () => Date;
}

const MAX_VALUE = 500;
const MAX_DEPTH = 3;
const MAX_ITEMS = 20;
const SECRET_NAME = /pass(word|wd)?|secret|token|cookie|authoriz|credential|api[_-]?key|master|private|session/i;

/** `LOG_FORMAT` when it is `json` or `text`; else json in production, text otherwise. */
export function resolveLogFormat(env: Record<string, string | undefined> = process.env): LogFormat {
  if (env.LOG_FORMAT === "json" || env.LOG_FORMAT === "text") return env.LOG_FORMAT;
  return env.NODE_ENV === "production" ? "json" : "text";
}

function clean(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value.length > MAX_VALUE ? `${value.slice(0, MAX_VALUE)}…` : value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) return { name: value.name, message: clean(value.message, depth) };
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map((item) => clean(item, depth + 1) ?? null);
  if (typeof value === "object") return cleanFields(value as LogFields, depth + 1);
  return undefined;
}

function cleanFields(fields: LogFields, depth: number): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SECRET_NAME.test(key)) {
      out[key] = "[redacted]";
      continue;
    }
    const cleaned = clean(value, depth);
    if (cleaned !== undefined) out[key] = cleaned;
  }
  return out;
}

const textValue = (value: unknown): string => {
  if (typeof value === "string") return /[\s="]/.test(value) || value === "" ? JSON.stringify(value) : value;
  return JSON.stringify(value);
};

function defaultSink(line: string, level: LogLevel): void {
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const format = options.format ?? resolveLogFormat();
  const sink = options.sink ?? defaultSink;
  const now = options.now ?? (() => new Date());
  const write = (level: LogLevel, event: string, fields: LogFields = {}) => {
    const ts = now().toISOString();
    const safe = cleanFields(fields, 0);
    for (const reserved of ["ts", "level", "event"]) delete safe[reserved];
    try {
      const line = format === "json" ? JSON.stringify({ ts, level, event, ...safe }) : [ts, level, event, ...Object.entries(safe).map(([key, value]) => `${key}=${textValue(value)}`)].join(" ");
      sink(line, level);
    } catch {
      // Logging must never be the reason a request fails.
    }
  };
  return {
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
  };
}

let shared: Logger | undefined;
const lazy = (): Logger => (shared ??= createLogger());

/** The process-wide logger. Its format is decided on first use, so a build that only imports it does not fix it. */
export const log: Logger = {
  debug: (event, fields) => lazy().debug(event, fields),
  info: (event, fields) => lazy().info(event, fields),
  warn: (event, fields) => lazy().warn(event, fields),
  error: (event, fields) => lazy().error(event, fields),
};
