import type pg from "pg";
import { resolveMasterKey } from "../auth/master-key.ts";
import type { Registry } from "../registry.ts";
import {
  APPEARANCE_NAMES,
  type AppearanceName,
  DEFAULT_APPEARANCE,
  moduleKey,
  platformKey,
} from "../settings/appearance.ts";
import { AppearanceService } from "../settings/appearance-service.ts";
import { type SettingEntry, SettingValueError, SettingsError, SettingsService } from "../settings/service.ts";
import { UsageError } from "./errors.ts";
import { readSecretValue } from "./password.ts";

export interface SettingsCommand {
  action: "list" | "get" | "set" | "unset";
  /** The key, and for `set` the value. */
  args: string[];
  /** `--module <id>`: the module whose settings, or whose appearance override, the command is about. */
  module: string | undefined;
  json: boolean;
}

export interface SettingsCommandDeps {
  pool: pg.Pool;
  registry: Registry;
  io: { out: (line: string) => void; err: (line: string) => void };
}

const ACTOR = "cli";
const APPEARANCE_PREFIX = "appearance.";
const isAppearanceKey = (key: string) => key.startsWith(APPEARANCE_PREFIX);

interface Row {
  key: string;
  type: string;
  value: string;
  source: string;
  flags: string;
}

function printTable(rows: Row[], io: SettingsCommandDeps["io"]): void {
  const width = (pick: (row: Row) => string, title: string) => Math.max(title.length, ...rows.map((row) => pick(row).length));
  const w = { key: width((r) => r.key, "KEY"), type: width((r) => r.type, "TYPE"), value: width((r) => r.value, "VALUE"), source: width((r) => r.source, "SOURCE") };
  io.out(`${"KEY".padEnd(w.key)}  ${"TYPE".padEnd(w.type)}  ${"VALUE".padEnd(w.value)}  ${"SOURCE".padEnd(w.source)}  FLAGS`);
  for (const row of rows) {
    io.out(`${row.key.padEnd(w.key)}  ${row.type.padEnd(w.type)}  ${row.value.padEnd(w.value)}  ${row.source.padEnd(w.source)}  ${row.flags}`.trimEnd());
  }
}

const appearanceType = (name: AppearanceName) => (name === "accentHue" ? "number" : "select");

function secretText(entry: SettingEntry): string {
  if (entry.secret === undefined || !entry.secret.set) return "(secret) not set";
  return entry.secret.unreadable ? "(secret) unreadable" : "(secret) set";
}

function settingRow(entry: SettingEntry): Row {
  const flags = [entry.incomplete && "incomplete", entry.invalid && "invalid"].filter((flag): flag is string => flag !== false);
  return {
    key: entry.key,
    type: entry.type,
    value: entry.type === "secret" ? secretText(entry) : entry.effective === null ? "-" : String(entry.effective),
    source: entry.source,
    flags: flags.join(", ") || "-",
  };
}

/** The module's own appearance rows: its override when it has one, the platform's value otherwise. */
async function moduleAppearanceRows(appearance: AppearanceService, moduleId: string): Promise<Row[]> {
  const state = await appearance.get();
  const own = state.modules[moduleId] ?? {};
  return (["accentHue", "radius"] as const).map((name) => {
    const overridden = own[name] !== undefined;
    return {
      key: platformKey(name),
      type: appearanceType(name),
      value: String(overridden ? own[name] : state.platform[name]),
      source: overridden ? "stored" : "platform",
      flags: "-",
    };
  });
}

async function platformAppearanceRows(appearance: AppearanceService): Promise<Row[]> {
  const state = await appearance.get();
  const stored = new Set((await appearance.stored()).map((row) => row.key));
  return APPEARANCE_NAMES.map((name) => ({
    key: platformKey(name),
    type: appearanceType(name),
    value: String(state.platform[name]),
    source: stored.has(platformKey(name)) ? "stored" : "default",
    flags: "-",
  }));
}

function appearanceName(key: string): AppearanceName {
  const name = key.slice(APPEARANCE_PREFIX.length);
  if (!(APPEARANCE_NAMES as readonly string[]).includes(name)) throw new SettingValueError(`unknown appearance setting "${name}"; the keys are ${APPEARANCE_NAMES.map(platformKey).join(", ")}`);
  return name as AppearanceName;
}

function moduleAppearanceName(key: string): "accentHue" | "radius" {
  const name = appearanceName(key);
  if (name === "theme") throw new SettingValueError("theme: cannot be overridden per module; it is the platform's, and each visitor can switch it");
  return name;
}

export async function runSettingsCommand(command: SettingsCommand, { pool, registry, io }: SettingsCommandDeps): Promise<void> {
  const present = await pool.query("select to_regclass('core.module_settings') is not null and to_regclass('core.platform_settings') is not null as present");
  if (!present.rows[0].present) throw new Error('the settings tables do not exist yet: run "npm run db:migrate" first');

  if (command.module === "core") throw new SettingsError('module "core" has no settings and no appearance of its own');

  const appearance = new AppearanceService(pool, registry);
  // The master key is only needed to read or write module settings (a secret may be among them).
  const moduleSettings = () => new SettingsService(pool, registry, { masterKey: resolveMasterKey() });

  const [key, value] = command.args;

  if (command.action === "list") {
    if (command.module === undefined) {
      const rows = await platformAppearanceRows(appearance);
      if (command.json) io.out(JSON.stringify(rows.map((row) => ({ key: row.key, type: row.type, effective: row.key === platformKey("accentHue") ? Number(row.value) : row.value, source: row.source })), null, 2));
      else printTable(rows, io);
      return;
    }
    const entries = await moduleSettings().describe(command.module);
    const own = await moduleAppearanceRows(appearance, command.module);
    if (command.json) {
      io.out(JSON.stringify([...entries, ...own.map((row) => ({ key: row.key, type: row.type, effective: row.key === platformKey("accentHue") ? Number(row.value) : row.value, source: row.source }))], null, 2));
    } else {
      printTable([...entries.map(settingRow), ...own], io);
    }
    return;
  }

  if (key === undefined) throw new UsageError(`settings ${command.action} needs a key`);

  if (isAppearanceKey(key)) {
    const name = appearanceName(key);
    if (command.module !== undefined && registry.get(command.module) === undefined) {
      throw new SettingsError(`module "${command.module}" is not registered`);
    }
    if (command.action === "get") {
      const state = await appearance.get();
      const own = command.module === undefined ? undefined : state.modules[command.module]?.[name as "accentHue" | "radius"];
      io.out(String(own ?? state.platform[name] ?? DEFAULT_APPEARANCE[name]));
      return;
    }
    if (command.action === "set") {
      if (value === undefined) throw new UsageError(`settings set ${key} needs a value`);
      if (command.module === undefined) await appearance.setPlatform({ [name]: value } as never, ACTOR);
      else await appearance.setModule(command.module, { [moduleAppearanceName(key)]: value } as never, ACTOR);
      io.out(command.module === undefined ? `set ${key}` : `set ${key} for ${command.module}`);
      return;
    }
    if (command.module === undefined) await appearance.unsetPlatform(name, ACTOR);
    else await appearance.unsetModule(command.module, moduleAppearanceName(key), ACTOR);
    io.out(command.module === undefined ? `unset ${key}` : `unset ${key} for ${command.module}`);
    return;
  }

  if (command.module === undefined) {
    throw new UsageError(`"${key}" is a module setting: say which module with --module <id> (platform appearance keys start with "appearance.")`);
  }
  const settings = moduleSettings();

  if (command.action === "get") {
    const entry = (await settings.describe(command.module)).find((candidate) => candidate.key === key);
    if (entry === undefined) throw new SettingsError(`module "${command.module}" does not declare a setting "${key}"`);
    if (entry.type === "secret") {
      // A secret that cannot be decrypted is an error here (exit 1), not a line that looks like a value.
      await settings.get(command.module, key);
      io.out(secretText(entry));
      return;
    }
    io.out(entry.effective === null ? "-" : String(entry.effective));
    return;
  }

  if (command.action === "set") {
    const declaration = (await settings.describe(command.module)).find((candidate) => candidate.key === key);
    if (declaration === undefined) throw new SettingsError(`module "${command.module}" does not declare a setting "${key}"`);
    let input: string;
    if (declaration.type === "secret") {
      if (value !== undefined) throw new UsageError("a secret's value is read from standard input, not given as an argument, so it stays out of the process list and the shell history");
      input = await readSecretValue(declaration.label);
    } else {
      if (value === undefined) throw new UsageError(`settings set ${key} needs a value`);
      input = value;
    }
    await settings.set(command.module, key, input, ACTOR);
    io.out(`set ${key} in ${command.module}`);
    return;
  }

  await settings.unset(command.module, key, ACTOR);
  io.out(`unset ${key} in ${command.module}`);
}

// Kept for the CLI's own help text and tests: the keys the command line accepts for appearance.
export const APPEARANCE_KEYS = APPEARANCE_NAMES.map(platformKey);
export const MODULE_APPEARANCE_KEYS = (["accentHue", "radius"] as const).map((name) => moduleKey("<id>", name));
