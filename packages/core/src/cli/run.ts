import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type pg from "pg";
import { AdminRefusedError, createAdministrator } from "../auth/admin.ts";
import { ROLES, type Role, createAuth } from "../auth/auth.ts";
import { createUser, isRole, listUsers, setUserRole } from "../auth/users.ts";
import { MASTER_KEY_ENV, resolveMasterKey } from "../auth/master-key.ts";
import { ModeRefusedError, readSignInMode, setSignInMode } from "../auth/mode.ts";
import { DEFAULT_WEB_ROOT, RegistrationError, generateRegistration, registrationModulesFor } from "../codegen/index.ts";
import { discoverModules, resolveModulesDir } from "../discovery.ts";
import { LifecycleRefusedError, LifecycleService, type ModuleStatus, fileHookLoader } from "../lifecycle/index.ts";
import { createPool, resolveDatabaseUrl } from "../pool.ts";
import { Registry } from "../registry.ts";
import { MigrationRunError, migrate, pendingMigrations } from "../runner.ts";
import { SettingValueError, SettingsError } from "../settings/service.ts";
import { DATA_DIR } from "../packages/paths.ts";
import { runNewCommand } from "./new.ts";
import { runAddCommand, runApplyCommand, runChangeCommand, runPackCommand } from "./packages.ts";
import { readPassword } from "./password.ts";
import { runSettingsCommand } from "./settings.ts";

/** Exit codes: a script can tell a refused action (the rules said no) from a bug or an environment problem. */
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;
export const EXIT_REFUSED = 3;

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

const consoleIo: CliIo = { out: (line) => console.log(line), err: (line) => console.error(line) };

const USAGE = `usage: modunexo <command> [options]

commands:
  modules list [--json]            every known module with its state and flags
  modules install <id>             available -> enabled (migrations, onInstall, onEnable)
  modules enable <id>              disabled -> enabled
  modules disable <id>             enabled -> disabled (data is kept)
                                   enable, disable and uninstall take --rebuild [--actor <name>] [--data-dir <path>]:
                                   rebuild the web app for the new state first, undo on failure, restart the server
  modules upgrade <id>             apply the package's newer version
  modules uninstall <id> --keep    leave the module's schema and migration history
  modules uninstall <id> --purge   drop the schema and the migration history
  modules new <id> [--name <text>] [--dir <parent>]
                                   write a working module folder (manifest, migration, page using getDb) to edit;
                                   default parent: modules-src/ at the repository root
  modules pack <folder> [--out <file>]
                                   build the archive of a module folder (writes manifest.json from manifest.ts)
  modules add <archive> [--sha256 <hex>] [--data-dir <path>] [--json]
                                   bring a package in and review it; nothing is installed or run
  modules apply <sha256> [--data-dir <path>] [--actor <name>] [--json]
                                   install or upgrade a package that "modules add" staged: place, build the web
                                   app, run the lifecycle, restart the server; undone if a step fails
  db:migrate                       apply the core migrations; report installed modules that need "modules upgrade"
  registry:generate [--dry-run] [--out <dir>]
                                   write the web app registration for the enabled modules
  admin create --email <email> --name <name>
                                   create an administrator; the password is read from standard input
                                   (a hidden prompt on a terminal), never from an argument
  user create --email <email> --name <name> --role admin|operator
                                   create a user; the password is read like "admin create". An admin can do
                                   everything; an operator uses the modules but cannot change the platform
                                   (apps, settings, identity, sign-in)
  user list [--json]               every user with the role
  user role --email <email> --role admin|operator
                                   change a role; the last active administrator cannot be demoted
  settings list [--module <id>] [--json]
                                   platform appearance, or a module's declared settings (and its appearance)
  settings get <key> [--module <id>]
  settings set <key> [<value>] [--module <id>]
                                   a secret's value is read from standard input, never from an argument
  settings unset <key> [--module <id>]
                                   keys: appearance.theme|accentHue|radius, or a key the module declares
  auth status                      whether the shell asks for a sign-in
  auth require                     ask for a sign-in (refused while no administrator exists)
  auth disable                     serve local requests without a sign-in

options for every command:
  --modules-dir <path>             where module packages are unpacked (default: modules/ at the repository root)
  --data-dir <path>                where received packages are kept (modules add, apply; default: MODUNEXO_DATA_DIR, else var/ at the repository root)
  --help                           print this text

environment: DATABASE_URL (and TEST_DATABASE_URL for the tests); admin create, user create and module settings also need ${MASTER_KEY_ENV}
exit codes: 0 done, 1 error, 2 usage error, 3 refused by a rule (lifecycle, registration conflict, administrator or sign-in mode)`;

import { Refusal, UsageError } from "./errors.ts";

const OPTIONS = {
  "modules-dir": { type: "string" },
  sha256: { type: "string" },
  "data-dir": { type: "string" },
  json: { type: "boolean" },
  keep: { type: "boolean" },
  purge: { type: "boolean" },
  "dry-run": { type: "boolean" },
  out: { type: "string" },
  dir: { type: "string" },
  email: { type: "string" },
  name: { type: "string" },
  role: { type: "string" },
  module: { type: "string" },
  actor: { type: "string" },
  rebuild: { type: "boolean" },
  help: { type: "boolean" },
} as const;

/** The options each command accepts besides `--modules-dir` and `--help`. */
const COMMAND_OPTIONS: Record<string, readonly string[]> = {
  "modules list": ["json"],
  "modules install": [],
  "modules enable": ["rebuild", "actor", "data-dir"],
  "modules disable": ["rebuild", "actor", "data-dir"],
  "modules upgrade": [],
  "modules uninstall": ["keep", "purge", "rebuild", "actor", "data-dir"],
  "modules new": ["name", "dir"],
  "modules pack": ["out"],
  "modules add": ["json", "sha256", "data-dir"],
  "modules apply": ["json", "data-dir", "actor"],
  "db:migrate": [],
  "registry:generate": ["dry-run", "out"],
  "admin create": ["email", "name"],
  "user create": ["email", "name", "role"],
  "user list": ["json"],
  "user role": ["email", "role"],
  "settings list": ["module", "json"],
  "settings get": ["module"],
  "settings set": ["module"],
  "settings unset": ["module"],
  "auth status": [],
  "auth require": [],
  "auth disable": [],
};

const ACTION_COMMANDS = ["install", "enable", "disable", "upgrade", "uninstall"] as const;
type ActionCommand = (typeof ACTION_COMMANDS)[number];

const REMINDER = 'Registration changed: run "npm run registry:generate", then rebuild and restart the web app for the change to be visible.';

interface Parsed {
  command: string;
  ids: string[];
  values: { [K in keyof typeof OPTIONS]?: string | boolean };
}

function parse(argv: string[]): Parsed | "help" {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  if (parsed.values.help) return "help";
  const [first, second, ...rest] = parsed.positionals;
  if (first === undefined) throw new UsageError("no command given");

  let command: string;
  let ids: string[];
  if (first === "modules") {
    if (second === undefined) throw new UsageError("no modules command given");
    if (second !== "list" && second !== "new" && second !== "pack" && second !== "add" && second !== "apply" && !ACTION_COMMANDS.includes(second as ActionCommand)) throw new UsageError(`unknown modules command "${second}"`);
    command = `modules ${second}`;
    ids = rest;
  } else if (first === "settings") {
    if (second !== "list" && second !== "get" && second !== "set" && second !== "unset") {
      throw new UsageError(second === undefined ? "no settings command given" : `unknown settings command "${second}"`);
    }
    command = `settings ${second}`;
    ids = rest;
  } else if (first === "auth") {
    if (second !== "status" && second !== "require" && second !== "disable") {
      throw new UsageError(second === undefined ? "no auth command given" : `unknown auth command "${second}"`);
    }
    command = `auth ${second}`;
    ids = rest;
  } else if (first === "admin") {
    if (second !== "create") throw new UsageError(second === undefined ? "no admin command given" : `unknown admin command "${second}"`);
    command = "admin create";
    ids = rest;
  } else if (first === "user") {
    if (second !== "create" && second !== "list" && second !== "role") throw new UsageError(second === undefined ? "no user command given" : `unknown user command "${second}"`);
    command = `user ${second}`;
    ids = rest;
  } else {
    command = first;
    ids = [...(second === undefined ? [] : [second]), ...rest];
  }
  const allowed = COMMAND_OPTIONS[command];
  if (allowed === undefined) throw new UsageError(`unknown command "${command}"`);

  for (const option of Object.keys(parsed.values)) {
    if (option !== "modules-dir" && option !== "help" && !allowed.includes(option)) throw new UsageError(`option --${option} does not apply to ${command}`);
  }
  if (command.startsWith("settings ")) {
    const limits: Record<string, [number, number]> = { "settings list": [0, 0], "settings get": [1, 1], "settings unset": [1, 1], "settings set": [1, 2] };
    const [least, most] = limits[command]!;
    if (ids.length < least || ids.length > most) {
      throw new UsageError(
        command === "settings list" ? `${command} takes no arguments` : command === "settings set" ? `${command} takes a key and, except for a secret, a value` : `${command} takes exactly one key`,
      );
    }
  }
  const takesId = command !== "modules list" && command.startsWith("modules ");
  if (!command.startsWith("settings ")) {
    const noun = command === "modules pack" ? "a folder" : command === "modules add" ? "an archive" : command === "modules apply" ? "a package SHA-256" : "a module id";
    if (takesId && ids.length === 0) throw new UsageError(`${command} needs ${noun}`);
    if (takesId ? ids.length !== 1 : ids.length > 0) throw new UsageError(takesId ? `${command} takes exactly one ${noun.slice(2)}` : `${command} takes no arguments`);
  }
  if (command === "modules apply" && !/^[0-9a-fA-F]{64}$/.test(ids[0]!)) throw new UsageError("modules apply takes the 64 hexadecimal characters of a package SHA-256");
  if ((typeof parsed.values.actor === "string" || typeof parsed.values["data-dir"] === "string") && !parsed.values.rebuild && command !== "modules apply" && command !== "modules add") {
    throw new UsageError(`--actor and --data-dir apply to ${command} only with --rebuild`);
  }
  if (typeof parsed.values.actor === "string" && !/^[A-Za-z0-9][A-Za-z0-9:._@-]{0,99}$/.test(parsed.values.actor)) {
    throw new UsageError("--actor takes a plain name (letters, digits and : . _ @ -, at most 100 characters)");
  }
  if (typeof parsed.values.sha256 === "string" && !/^[0-9a-fA-F]{64}$/.test(parsed.values.sha256)) {
    throw new UsageError("--sha256 takes 64 hexadecimal characters");
  }
  if (parsed.values.keep && parsed.values.purge) throw new UsageError("uninstall takes --keep or --purge, not both");
  if (command === "admin create") {
    for (const option of ["email", "name"] as const) {
      if (typeof parsed.values[option] !== "string" || parsed.values[option].trim() === "") throw new UsageError(`admin create needs --${option}`);
    }
  }
  if (command === "user create" || command === "user role") {
    const needed = command === "user create" ? (["email", "name", "role"] as const) : (["email", "role"] as const);
    for (const option of needed) {
      if (typeof parsed.values[option] !== "string" || parsed.values[option].trim() === "") throw new UsageError(`${command} needs --${option}`);
    }
    if (!isRole(parsed.values.role)) throw new UsageError(`--role takes ${ROLES.join(" or ")}`);
  }
  return { command, ids, values: parsed.values };
}

interface Context {
  modulesDir: string;
  registry: Registry;
}

/**
 * The registry of everything on disk, with unsupported-platform admission: a package the SDK cannot run is
 * listed and refused where it matters (at install), instead of making every command fail.
 */
async function loadContext(modulesDir: string, io: CliIo): Promise<Context> {
  const registry = new Registry({ allowUnsupportedPlatform: true });
  registry.registerCore();
  const { modules, warnings } = await discoverModules(modulesDir);
  for (const warning of warnings) io.err(`warning: ${warning}`);
  for (const manifest of modules) registry.register(manifest);
  return { modulesDir, registry };
}

const cell = (value: string | undefined, width: number) => (value ?? "-").padEnd(width);

function flagsOf(status: ModuleStatus): string[] {
  return [
    status.upgradePending && "upgrade-pending",
    status.orphaned && "orphaned",
    status.dataRetained && "data-retained",
    status.invalidInstalledVersion && "invalid-version",
  ].filter((flag): flag is string => flag !== false);
}

function printList(statuses: ModuleStatus[], io: CliIo): void {
  if (statuses.length === 0) {
    io.out("no modules found");
    return;
  }
  const idWidth = Math.max(2, ...statuses.map((s) => s.id.length));
  const rows = statuses.map((s) => [s.id, s.status, s.packageVersion, s.installedVersion, flagsOf(s).join(", ") || undefined] as const);
  io.out(`${"ID".padEnd(idWidth)}  ${"STATE".padEnd(9)}  ${"PACKAGE".padEnd(10)}  ${"INSTALLED".padEnd(10)}  FLAGS`);
  for (const [id, state, packageVersion, installed, flags] of rows) {
    io.out(`${cell(id, idWidth)}  ${cell(state, 9)}  ${cell(packageVersion, 10)}  ${cell(installed, 10)}  ${flags ?? "-"}`.trimEnd());
  }
}

async function modulesCommand(parsed: Parsed, service: LifecycleService, io: CliIo): Promise<void> {
  const action = parsed.command.slice("modules ".length);
  const id = parsed.ids[0];
  if (action === "list") {
    const statuses = await service.list();
    if (parsed.values.json) io.out(JSON.stringify(statuses, null, 2));
    else printList(statuses, io);
    return;
  }
  let line: string;
  switch (action as ActionCommand) {
    case "install": {
      const plan = await service.install(id!);
      line = `installed "${id}" ${plan.version} (${plan.from} -> ${plan.to})`;
      break;
    }
    case "enable": {
      const plan = await service.enable(id!);
      line = `enabled "${id}" ${plan.version} (${plan.from} -> ${plan.to})`;
      break;
    }
    case "disable": {
      const plan = await service.disable(id!);
      line = `disabled "${id}" ${plan.version} (${plan.from} -> ${plan.to})`;
      break;
    }
    case "upgrade": {
      const plan = await service.upgrade(id!);
      if (plan.noop) {
        io.out(`"${id}" is already at ${plan.version}; nothing to do`);
        return;
      }
      line = `upgraded "${id}" ${plan.previousVersion} -> ${plan.version} (${plan.to})`;
      break;
    }
    case "uninstall": {
      // No flag is not rejected here: the lifecycle refuses it, so the rule and its message live in one place.
      const mode = parsed.values.keep ? "keep" : parsed.values.purge ? "purge" : undefined;
      const plan = await service.uninstall(id!, mode);
      line = `uninstalled "${id}" (${plan.mode})`;
      break;
    }
  }
  io.out(line);
  io.out(REMINDER);
}

/**
 * Applies the core's migrations. A module's schema changes only through the lifecycle: install applies its first
 * migrations and upgrade applies later ones, so `core.modules.installed_version` always matches the schema. For
 * the installed modules this command therefore only reports what is waiting for an upgrade, and what it cannot check.
 */
async function migrateCommand(context: Context, service: LifecycleService, pool: pg.Pool, io: CliIo): Promise<void> {
  const coreOnly = new Registry();
  coreOnly.registerCore();
  const { applied } = await migrate(pool, coreOnly);
  if (applied.length === 0) io.out("nothing to apply");
  for (const { moduleId, filename } of applied) io.out(`applied ${moduleId}/${filename}`);

  for (const status of (await service.list()).filter((s) => s.status !== "available")) {
    const manifest = context.registry.get(status.id);
    if (manifest === undefined) {
      io.err(`warning: module "${status.id}" is installed but its package is not on disk; skipped`);
      continue;
    }
    try {
      const pending = await pendingMigrations(pool, manifest);
      if (pending.length === 0) continue;
      const names = pending.map((file) => file.filename).join(", ");
      const next = status.upgradePending ? `run "modules upgrade ${status.id}"` : `its version is unchanged, so raise its version and then run "modules upgrade ${status.id}"`;
      io.err(`warning: module "${status.id}" has ${pending.length} pending migration(s) (${names}); db:migrate does not apply them: ${next}`);
    } catch (error) {
      io.err(`warning: module "${status.id}": cannot check its migrations: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function generateCommand(parsed: Parsed, context: Context, service: LifecycleService, io: CliIo): Promise<void> {
  const { modules, warnings } = registrationModulesFor(await service.list(), context.registry, context.modulesDir);
  for (const warning of warnings) io.err(`warning: ${warning}`);
  const dryRun = parsed.values["dry-run"] === true;
  const out = parsed.values.out;
  const plan = generateRegistration(modules, { outDir: typeof out === "string" ? resolve(out) : DEFAULT_WEB_ROOT, dryRun });
  for (const warning of plan.warnings) io.err(`warning: ${warning}`);

  const verb = dryRun ? "would " : "";
  io.out(
    dryRun
      ? `dry run: would write ${plan.writes.length} file(s), delete ${plan.deletions.length}, leave ${plan.unchanged.length} unchanged in ${plan.root}`
      : `wrote ${plan.writes.length} file(s), deleted ${plan.deletions.length}, left ${plan.unchanged.length} unchanged in ${plan.root}`,
  );
  for (const write of plan.writes) io.out(`  ${verb}${dryRun ? "write" : "wrote"} ${write.path} (${write.change})`);
  for (const path of plan.deletions) io.out(`  ${verb}${dryRun ? "delete" : "deleted"} ${path}`);
}

/**
 * Creates an administrator. The password comes from standard input so it never appears in the process list or in
 * the shell history. This command reads no module, so a broken modules directory cannot lock the owner out.
 */
async function adminCreateCommand(parsed: Parsed, pool: pg.Pool, io: CliIo): Promise<void> {
  const masterKey = resolveMasterKey();
  const migrated = await pool.query("select to_regclass('core.auth_user') is not null as present");
  if (!migrated.rows[0].present) throw new Error('the authentication tables do not exist yet: run "npm run db:migrate" first');
  const password = await readPassword();
  // The CLI serves no request, so the origin is never used; it is given only so the library does not warn about it.
  // The background schema check is off: it would race the pool being closed when this command refuses and exits.
  const auth = createAuth({ pool, masterKey, baseURL: "http://localhost", validateSchema: false });
  const user = await createAdministrator(auth, { email: parsed.values.email as string, name: parsed.values.name as string, password });
  io.out(`created administrator "${user.email}"`);
}

/** The CLI serves no request, so the origin is never used; the background schema check would race the pool closing. */
const cliAuth = (pool: pg.Pool) => createAuth({ pool, masterKey: resolveMasterKey(), baseURL: "http://localhost", validateSchema: false });

async function requireAuthTables(pool: pg.Pool): Promise<void> {
  const migrated = await pool.query("select to_regclass('core.auth_user') is not null as present");
  if (!migrated.rows[0].present) throw new Error('the authentication tables do not exist yet: run "npm run db:migrate" first');
}

/** Users and their roles. Only `create` needs the master key (it hashes a password); the others work while locked out. */
async function userCommand(parsed: Parsed, pool: pg.Pool, io: CliIo): Promise<void> {
  const action = parsed.command.slice("user ".length);
  await requireAuthTables(pool);
  if (action === "list") {
    const all = await listUsers(pool);
    if (parsed.values.json === true) {
      io.out(JSON.stringify(all, null, 2));
      return;
    }
    if (all.length === 0) io.out("no users yet");
    for (const user of all) io.out(`${cell(user.email, 36)} ${cell(user.role, 10)} ${user.banned ? "banned" : ""}`.trimEnd());
    return;
  }
  const role = parsed.values.role as Role;
  if (action === "create") {
    const auth = cliAuth(pool);
    const password = await readPassword();
    const user = await createUser(auth, { email: parsed.values.email as string, name: parsed.values.name as string, password, role });
    io.out(`created ${user.role} "${user.email}"`);
    return;
  }
  const change = await setUserRole(pool, parsed.values.email as string, role);
  io.out(change.changed ? `"${change.email}" is now ${change.role}` : `"${change.email}" already is ${change.role}`);
}

const SIGN_IN_DISABLED_NOTICE = [
  "sign-in is now disabled.",
  "Anyone who can reach this server from the local network can use it, including installing modules,",
  "which runs code with access to the database. Requests that carry a public address are refused.",
  'Switch it back on with "npm run modunexo -- auth require".',
];

/** The sign-in mode lives in the database and needs no master key, so it can be changed while locked out. */
async function authCommand(parsed: Parsed, pool: pg.Pool, io: CliIo): Promise<void> {
  const present = await pool.query("select to_regclass('core.platform_settings') is not null as present");
  if (!present.rows[0].present) throw new Error('the platform settings table does not exist yet: run "npm run db:migrate" first');

  const action = parsed.command.slice("auth ".length);
  if (action === "status") {
    io.out(`sign-in: ${await readSignInMode(pool)}`);
    return;
  }
  const mode = action === "disable" ? "disabled" : "required";
  const result = await setSignInMode(pool, mode, "cli");
  if (!result.changed) {
    io.out(`sign-in is already ${mode}; nothing to do`);
    return;
  }
  if (mode === "disabled") for (const line of SIGN_IN_DISABLED_NOTICE) io.out(line);
  else io.out("sign-in is now required.");
}

/** Run one CLI invocation and return its exit code. Everything the user sees goes through `io`. */
export async function runCli(argv: string[], io: CliIo = consoleIo): Promise<number> {
  let pool: pg.Pool | undefined;
  try {
    const parsed = parse(argv);
    if (parsed === "help") {
      io.out(USAGE);
      return EXIT_OK;
    }
    if (parsed.command.startsWith("settings ")) {
      let modulesDir: string;
      try {
        modulesDir = resolveModulesDir(typeof parsed.values["modules-dir"] === "string" ? parsed.values["modules-dir"] : undefined);
      } catch (error) {
        throw new UsageError(error instanceof Error ? error.message : String(error));
      }
      const context = await loadContext(modulesDir, io);
      pool = createPool(resolveDatabaseUrl(), { connectionTimeoutMillis: 5000 });
      await runSettingsCommand(
        {
          action: parsed.command.slice("settings ".length) as "list" | "get" | "set" | "unset",
          args: parsed.ids,
          module: typeof parsed.values.module === "string" ? parsed.values.module : undefined,
          json: parsed.values.json === true,
        },
        { pool, registry: context.registry, io },
      );
      return EXIT_OK;
    }
    const rebuilding = parsed.values.rebuild === true && ["modules enable", "modules disable", "modules uninstall"].includes(parsed.command);
    if (rebuilding) {
      let changeModulesDir: string;
      try {
        changeModulesDir = resolveModulesDir(typeof parsed.values["modules-dir"] === "string" ? parsed.values["modules-dir"] : undefined);
      } catch (error) {
        throw new UsageError(error instanceof Error ? error.message : String(error));
      }
      pool = createPool(resolveDatabaseUrl(), { connectionTimeoutMillis: 5000 });
      await runChangeCommand(
        {
          action: parsed.command.slice("modules ".length) as "enable" | "disable" | "uninstall",
          moduleId: parsed.ids[0]!,
          ...(parsed.values.keep ? { mode: "keep" as const } : parsed.values.purge ? { mode: "purge" as const } : {}),
          actor: typeof parsed.values.actor === "string" ? parsed.values.actor : "cli",
          dataDir: typeof parsed.values["data-dir"] === "string" ? parsed.values["data-dir"] : DATA_DIR,
          modulesDir: changeModulesDir,
        },
        pool,
        io,
      );
      return EXIT_OK;
    }
    if (parsed.command === "modules new") {
      await runNewCommand(
        { id: parsed.ids[0]!, ...(typeof parsed.values.name === "string" ? { name: parsed.values.name } : {}), ...(typeof parsed.values.dir === "string" ? { dir: parsed.values.dir } : {}) },
        io,
      );
      return EXIT_OK;
    }
    if (parsed.command === "modules pack" || parsed.command === "modules add" || parsed.command === "modules apply") {
      let packagesModulesDir: string;
      try {
        packagesModulesDir = resolveModulesDir(typeof parsed.values["modules-dir"] === "string" ? parsed.values["modules-dir"] : undefined);
      } catch (error) {
        throw new UsageError(error instanceof Error ? error.message : String(error));
      }
      if (parsed.command === "modules pack") {
        await runPackCommand({ folder: parsed.ids[0]!, ...(typeof parsed.values.out === "string" ? { out: parsed.values.out } : {}), modulesDir: packagesModulesDir }, io);
        return EXIT_OK;
      }
      pool = createPool(resolveDatabaseUrl(), { connectionTimeoutMillis: 5000 });
      if (parsed.command === "modules apply") {
        await runApplyCommand(
          {
            sha256: parsed.ids[0]!.toLowerCase(),
            json: parsed.values.json === true,
            actor: typeof parsed.values.actor === "string" ? parsed.values.actor : "cli",
            dataDir: typeof parsed.values["data-dir"] === "string" ? parsed.values["data-dir"] : DATA_DIR,
            modulesDir: packagesModulesDir,
          },
          pool,
          io,
        );
        return EXIT_OK;
      }
      await runAddCommand(
        {
          archive: parsed.ids[0]!,
          ...(typeof parsed.values.sha256 === "string" ? { sha256: parsed.values.sha256 } : {}),
          json: parsed.values.json === true,
          dataDir: typeof parsed.values["data-dir"] === "string" ? parsed.values["data-dir"] : DATA_DIR,
          modulesDir: packagesModulesDir,
        },
        pool,
        io,
      );
      return EXIT_OK;
    }
    if (parsed.command.startsWith("auth ")) {
      pool = createPool(resolveDatabaseUrl(), { connectionTimeoutMillis: 5000 });
      await authCommand(parsed, pool, io);
      return EXIT_OK;
    }
    if (parsed.command === "admin create") {
      pool = createPool(resolveDatabaseUrl(), { connectionTimeoutMillis: 5000 });
      await adminCreateCommand(parsed, pool, io);
      return EXIT_OK;
    }
    if (parsed.command.startsWith("user ")) {
      pool = createPool(resolveDatabaseUrl(), { connectionTimeoutMillis: 5000 });
      await userCommand(parsed, pool, io);
      return EXIT_OK;
    }
    let modulesDir: string;
    try {
      modulesDir = resolveModulesDir(typeof parsed.values["modules-dir"] === "string" ? parsed.values["modules-dir"] : undefined);
    } catch (error) {
      throw new UsageError(error instanceof Error ? error.message : String(error));
    }

    const url = resolveDatabaseUrl();
    const context = await loadContext(modulesDir, io);
    pool = createPool(url, { connectionTimeoutMillis: 5000 });
    const service = new LifecycleService(pool, context.registry, { loadHooks: fileHookLoader(modulesDir) });

    if (parsed.command === "db:migrate") await migrateCommand(context, service, pool, io);
    else if (parsed.command === "registry:generate") await generateCommand(parsed, context, service, io);
    else await modulesCommand(parsed, service, io);
    return EXIT_OK;
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`error: ${error.message}`);
      io.err(`${USAGE.split("\n")[0]} (run with --help for the commands)`);
      return EXIT_USAGE;
    }
    if (error instanceof Refusal || error instanceof LifecycleRefusedError || error instanceof RegistrationError || error instanceof AdminRefusedError || error instanceof ModeRefusedError || error instanceof SettingsError || error instanceof SettingValueError) {
      io.err(`refused: ${error.message}`);
      return EXIT_REFUSED;
    }
    io.err(error instanceof Error ? error.message : String(error));
    if (error instanceof MigrationRunError && error.applied.length > 0) {
      // Those files are committed and stay applied; say so, so a failed deploy is not mistaken for a clean rollback.
      io.err("applied before the failure:");
      for (const { moduleId, filename } of error.applied) io.err(`  ${moduleId}/${filename}`);
    }
    return EXIT_ERROR;
  } finally {
    await pool?.end();
  }
}
