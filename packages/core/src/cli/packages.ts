import type pg from "pg";
import { ApplyFailedError, ApplyRefusedError, BuildFailedError, applyPackage, changeModule, requestRestart } from "../install/index.ts";
import { DATA_DIR, PackRefusedError, buildPackageContext, intakePackage, packFolder } from "../packages/index.ts";
import { Refusal } from "./errors.ts";
import type { CliIo } from "./run.ts";

const list = (values: string[]): string => (values.length === 0 ? "none" : values.join(", "));

/** `modules pack <folder> [--out <file>]`: builds the archive a platform accepts. Needs no database. */
export async function runPackCommand(args: { folder: string; out?: string; modulesDir: string }, io: CliIo): Promise<void> {
  const context = await buildPackageContext({ modulesDir: args.modulesDir });
  try {
    const result = await packFolder(args.folder, context, args.out);
    io.out(`packed ${result.outFile} (${result.sizeBytes} bytes)`);
    io.out(`sha256 ${result.sha256}`);
    io.out(`${result.manifest.id} ${result.manifest.version}: give the file and this SHA-256 to whoever installs it ("modules add <archive> --sha256 <hex>").`);
  } catch (error) {
    if (error instanceof PackRefusedError) throw new Refusal(error.problems.join("\n  "));
    throw error;
  }
}

/**
 * `modules add <archive> [--sha256 <hex>]`: brings a package into the platform and shows what it would do. The
 * package is read as data and nothing is installed; installing is a separate, deliberate step.
 */
export async function runAddCommand(
  args: { archive: string; sha256?: string; json: boolean; dataDir?: string; modulesDir: string },
  pool: pg.Pool,
  io: CliIo,
): Promise<void> {
  const context = await buildPackageContext({ modulesDir: args.modulesDir, pool });
  const result = await intakePackage({
    pool,
    archive: args.archive,
    ...(args.sha256 === undefined ? {} : { expectedSha256: args.sha256 }),
    actor: "cli",
    dataDir: args.dataDir ?? DATA_DIR,
    context,
  });
  if (!result.ok) throw new Refusal(result.problems.join("\n  "));

  const { review } = result;
  if (args.json) {
    io.out(JSON.stringify({ status: "staged", sha256: result.sha256, sizeBytes: result.sizeBytes, alreadyStaged: result.alreadyStaged, review }, null, 2));
    return;
  }
  const row = (label: string, value: string) => io.out(`  ${label.padEnd(12)}${value}`);
  io.out(`staged ${review.id} ${review.version} (${review.name})${result.alreadyStaged ? " - it was already staged" : ""}`);
  row("sha256", result.sha256);
  row("size", `${result.sizeBytes} bytes`);
  row("package", review.packageName);
  row("platform", review.platform);
  row("pages", list(review.pages.map((page) => page.path)));
  const open = review.pages.filter((page) => page.public === true);
  if (open.length > 0) row("public", `${list(open.map((page) => page.path))} - answer without a sign-in, guarded only by their signature`);
  row("nav", list(review.nav.map((item) => item.label)));
  row("permissions", list(review.permissions.map((permission) => permission.key)));
  row("settings", list(review.settings.map((setting) => setting.key)));
  row("migrations", list(review.migrations));
  row("hooks", review.runsHooks ? "yes - the package's own code runs inside the platform when installed" : "none");
  row("depends on", list(review.dependsOn.map((need) => `${need.id} ${need.range} (${need.status})`)));
  row("libraries", list(review.dependencies.map((dependency) => `${dependency.name} ${dependency.range}`)));
  row("scripts", review.scripts.length === 0 ? "none (never run)" : `${review.scripts.join(", ")} (never run)`);
  io.out("Nothing was installed. The package was read as data; none of its code was run.");
}

/**
 * `modules apply <sha256>`: installs or upgrades a package that `modules add` staged: places it, builds the web
 * app with it, runs the lifecycle and asks the running server to restart. Takes minutes (the build); every step
 * is printed, and a failure undoes what it can and says what it could not.
 */
export async function runApplyCommand(args: { sha256: string; json: boolean; actor: string; dataDir: string; modulesDir: string }, pool: pg.Pool, io: CliIo): Promise<void> {
  try {
    const result = await applyPackage({
      pool,
      sha256: args.sha256,
      actor: args.actor,
      dataDir: args.dataDir,
      modulesDir: args.modulesDir,
      requestRestart: () => requestRestart({ dataDir: args.dataDir }),
      onStep: (step, detail) => {
        if (!args.json) io.out(`[${step}] ${detail}`);
      },
    });
    for (const warning of result.warnings) io.err(`warning: ${warning}`);
    if (args.json) {
      io.out(JSON.stringify({ status: "succeeded", ...result }, null, 2));
      return;
    }
    io.out(`${result.kind === "install" ? "installed" : "upgraded"} ${result.moduleId} ${result.version} (operation ${result.operationId})`);
    io.out(result.restart);
  } catch (error) {
    if (error instanceof ApplyRefusedError) throw new Refusal(error.message);
    if (error instanceof ApplyFailedError && error.cause instanceof BuildFailedError) {
      io.err("the last lines of the build:");
      for (const line of error.cause.output.trim().split("\n").slice(-25)) io.err(`  ${line}`);
    }
    throw error;
  }
}

/**
 * `modules enable|disable|uninstall <id> --rebuild`: the state change with the rebuild pipeline: the web app is
 * built for the new state first, the lifecycle runs, the server restarts, and a failure puts the build back.
 */
export async function runChangeCommand(
  args: { action: "enable" | "disable" | "uninstall"; moduleId: string; mode?: "keep" | "purge"; actor: string; dataDir: string; modulesDir: string },
  pool: pg.Pool,
  io: CliIo,
): Promise<void> {
  try {
    const result = await changeModule({
      pool,
      moduleId: args.moduleId,
      action: args.action,
      ...(args.mode === undefined ? {} : { mode: args.mode }),
      actor: args.actor,
      dataDir: args.dataDir,
      modulesDir: args.modulesDir,
      requestRestart: () => requestRestart({ dataDir: args.dataDir }),
      onStep: (step, detail) => io.out(`[${step}] ${detail}`),
    });
    for (const warning of result.warnings) io.err(`warning: ${warning}`);
    io.out(`${args.action === "enable" ? "enabled" : args.action === "disable" ? "disabled" : "uninstalled"} ${result.moduleId} (operation ${result.operationId})`);
    io.out(result.restart);
  } catch (error) {
    if (error instanceof ApplyRefusedError) throw new Refusal(error.message);
    if (error instanceof ApplyFailedError && error.cause instanceof BuildFailedError) {
      io.err("the last lines of the build:");
      for (const line of error.cause.output.trim().split("\n").slice(-25)) io.err(`  ${line}`);
    }
    throw error;
  }
}
