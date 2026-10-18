import { dirname, resolve } from "node:path";
import { MODULES_DIR } from "../discovery.ts";
import { ScaffoldRefusedError, scaffoldModule } from "../scaffold/module.ts";
import { Refusal } from "./errors.ts";
import type { CliIo } from "./run.ts";

/** Where new module sources go when `--dir` is not given: `modules-src/` beside `modules/`, inside the repository so `@epnexo/sdk` resolves. */
export const SOURCES_DIR = resolve(dirname(MODULES_DIR), "modules-src");

/** `modules new <id> [--name <text>] [--dir <parent>]`: writes a working module folder. Needs no database. */
export async function runNewCommand(args: { id: string; name?: string; dir?: string }, io: CliIo): Promise<void> {
  try {
    const result = await scaffoldModule({ id: args.id, ...(args.name === undefined ? {} : { name: args.name }), parentDir: resolve(args.dir ?? SOURCES_DIR) });
    io.out(`created ${result.folder}`);
    for (const file of result.files) io.out(`  ${file}`);
    io.out(`next: edit it, then build the archive with "modules pack ${result.folder}", review it with "modules add", and install it with "modules apply".`);
  } catch (error) {
    if (error instanceof ScaffoldRefusedError) throw new Refusal(error.message);
    throw error;
  }
}
