import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type pg from "pg";
import { AdminRefusedError, createAdministrator } from "../auth/admin.ts";
import { createAuth } from "../auth/auth.ts";
import { MASTER_KEY_ENV, resolveMasterKey } from "../auth/master-key.ts";
import { DEFAULT_WEB_ROOT, RegistrationError, generateRegistration, registrationModulesFor } from "../codegen/index.ts";
import { discoverModules, resolveModulesDir } from "../discovery.ts";
import { LifecycleRefusedError, LifecycleService, type ModuleStatus, fileHookLoader } from "../lifecycle/index.ts";
import { createPool, resolveDatabaseUrl } from "../pool.ts";
import { Registry } from "../registry.ts";
import { MigrationRunError, migrate, pendingMigrations } from "../runner.ts";
import { readPassword } from "./password.ts";

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

const USAGE = `usage: epnexo <command> [options]

commands:
  modules list [--json]            every known module with its state and flags
  modules install <id>             available -> enabled (migrations, onInstall, onEnable)
  modules enable <id>              disabled -> enabled
  modules disable <id>             enabled -> disabled (data is kept)
  modules upgrade <id>             apply the package's newer version
  modules uninstall <id> --keep    leave the module's schema and migration history
  modules uninstall <id> --purge   drop the schema and the migration history
  db:migrate                       apply the core migrations; report installed modules that need "modules upgrade"
  registry:generate [--dry-run] [--out <dir>]
                                   write the web app registration for the enabled modules
  admin create --email <email> --name <name>
                                   create an administrator; the password is read from standard input
                                   (a hidden prompt on a terminal), never from an argument

options for every command:
  --modules-dir <path>             where module packages are unpacked (default: modules/ at the repository root)
  --help                           print this text

environment: DATABASE_URL (and TEST_DATABASE_URL for the tests); admin create also needs ${MASTER_KEY_ENV}
exit codes: 0 done, 1 error, 2 usage error, 3 refused by the lifecycle rules, by a registration conflict or by an administrator rule`;

class UsageError extends Error {}
/** The action was understood and refused by a rule; nothing was changed. */
class Refusal extends Error {}

const OPTIONS = {
  "modules-dir": { type: "string" },
  json: { type: "boolean" },
  keep: { type: "boolean" },
  purge: { type: "boolean" },
  "dry-run": { type: "boolean" },
  out: { type: "string" },
  email: { type: "string" },
  name: { type: "string" },
  help: { type: "boolean" },
} as const;

/** The options each command accepts besides `--modules-dir` and `--help`. */
const COMMAND_OPTIONS: Record<string, readonly string[]> = {
  "modules list": ["json"],
  "modules install": [],
  "modules enable": [],
  "modules disable": [],
  "modules upgrade": [],
  "modules uninstall": ["keep", "purge"],
  "db:migrate": [],
  "registry:generate": ["dry-run", "out"],
  "admin create": ["email", "name"],
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
    if (second !== "list" && !ACTION_COMMANDS.includes(second as ActionCommand)) throw new UsageError(`unknown modules command "${second}"`);
    command = `modules ${second}`;
    ids = rest;
  } else if (first === "admin") {
    if (second !== "create") throw new UsageError(second === undefined ? "no admin command given" : `unknown admin command "${second}"`);
    command = "admin create";
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
  const takesId = command !== "modules list" && command.startsWith("modules ");
  if (takesId && ids.length === 0) throw new UsageError(`${command} needs a module id`);
  if (takesId ? ids.length !== 1 : ids.length > 0) throw new UsageError(takesId ? `${command} takes exactly one module id` : `${command} takes no arguments`);
  if (parsed.values.keep && parsed.values.purge) throw new UsageError("uninstall takes --keep or --purge, not both");
  if (command === "admin create") {
    for (const option of ["email", "name"] as const) {
      if (typeof parsed.values[option] !== "string" || parsed.values[option].trim() === "") throw new UsageError(`admin create needs --${option}`);
    }
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

/** Run one CLI invocation and return its exit code. Everything the user sees goes through `io`. */
export async function runCli(argv: string[], io: CliIo = consoleIo): Promise<number> {
  let pool: pg.Pool | undefined;
  try {
    const parsed = parse(argv);
    if (parsed === "help") {
      io.out(USAGE);
      return EXIT_OK;
    }
    if (parsed.command === "admin create") {
      pool = createPool(resolveDatabaseUrl(), { connectionTimeoutMillis: 5000 });
      await adminCreateCommand(parsed, pool, io);
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
    if (error instanceof Refusal || error instanceof LifecycleRefusedError || error instanceof RegistrationError || error instanceof AdminRefusedError) {
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
