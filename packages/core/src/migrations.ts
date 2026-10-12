import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface MigrationFile {
  filename: string;
  sql: string;
  checksum: string;
}

const MIGRATION_NAME = /^(\d{4})_[a-z0-9_]+\.sql$/;

export function checksum(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Read `NNNN_name.sql` files from a directory, ordered by name. Other file types and subdirectories are ignored. */
export function readMigrationFiles(dir: string): MigrationFile[] {
  if (!existsSync(dir)) throw new Error(`migrations directory "${dir}" does not exist`);

  const names = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();

  const seen = new Map<string, string>();
  return names.map((filename) => {
    const match = MIGRATION_NAME.exec(filename);
    if (!match) throw new Error(`migration file "${filename}" does not match NNNN_name.sql (lowercase letters, digits, underscores)`);
    const number = match[1]!;
    const clash = seen.get(number);
    if (clash) throw new Error(`duplicate migration number ${number}: "${clash}" and "${filename}"`);
    seen.set(number, filename);
    const sql = readFileSync(join(dir, filename), "utf8");
    return { filename, sql, checksum: checksum(sql) };
  });
}

/**
 * Compare files on disk with what the database recorded and return the ones still to apply, in order.
 * Throws if history was rewritten: an applied file was edited, removed, or a new file was slipped in before it.
 */
export function planMigrations(files: MigrationFile[], applied: ReadonlyMap<string, string>): MigrationFile[] {
  const onDisk = new Set(files.map((f) => f.filename));
  for (const filename of applied.keys()) {
    if (!onDisk.has(filename)) throw new Error(`migration "${filename}" was applied but is missing from disk`);
  }

  const latestApplied = [...applied.keys()].sort().at(-1);
  const pending: MigrationFile[] = [];
  for (const file of files) {
    const recorded = applied.get(file.filename);
    if (recorded === undefined) {
      if (latestApplied !== undefined && file.filename < latestApplied) {
        throw new Error(`migration "${file.filename}" is older than the latest applied migration "${latestApplied}"`);
      }
      pending.push(file);
    } else if (recorded !== file.checksum) {
      throw new Error(`migration "${file.filename}" was modified after it was applied (recorded checksum differs from the file on disk)`);
    }
  }
  return pending;
}
