import { randomBytes } from "node:crypto";
import { cpSync, existsSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Moves a folder with `rename`, or with this when the platform's own rename is what is under test. */
export type Rename = (from: string, to: string) => void;

/**
 * Moves a folder to a path that does not exist yet. A rename is atomic and free, so it is tried first. It cannot
 * cross volumes, though: when `from` and `to` are on different mounts (the modules folder and the data folder are
 * separate volumes in a container deployment) the system answers EXDEV, and the folder is copied and then removed.
 *
 * The copy is made under a hidden temporary name beside `to` and renamed into place only once it is whole, so a copy that
 * fails leaves nothing at `to`, and the source is removed only after that. Any other error is passed through.
 */
export function moveDir(from: string, to: string, rename: Rename = renameSync): void {
  try {
    rename(from, to);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
  }
  if (existsSync(to)) throw new Error(`${to} already exists`);
  // Hidden, like the folder a placement builds before it swaps it in, so nothing that lists the folder takes it for a module.
  const partial = join(dirname(to), `.${basename(to)}.moving-${randomBytes(6).toString("hex")}`);
  try {
    cpSync(from, partial, { recursive: true, errorOnExist: true, force: false, dereference: false, verbatimSymlinks: true, preserveTimestamps: true });
    renameSync(partial, to);
  } catch (error) {
    rmSync(partial, { recursive: true, force: true });
    throw error;
  }
  rmSync(from, { recursive: true, force: true });
}
