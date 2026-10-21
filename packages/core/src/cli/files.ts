import type pg from "pg";
import { FileError, FileService, defaultFileStorage } from "../files/index.ts";
import type { Registry } from "../registry.ts";
import type { CliOutput } from "./jobs.ts";

export interface FilesCommand {
  action: "list" | "delete";
  /** `list`: an optional module id. `delete`: the module id and the file id. */
  args: string[];
  limit: number | undefined;
  json: boolean;
}

function printTable(files: { id: string; moduleId: string; name: string; contentType: string; size: number; createdAt: string }[], io: CliOutput): void {
  const when = (iso: string) => iso.slice(0, 19).replace("T", " ");
  const rows = files.map((f) => [f.id, f.moduleId, f.name, f.contentType, String(f.size), when(f.createdAt)]);
  const titles = ["ID", "MODULE", "NAME", "TYPE", "SIZE", "CREATED"];
  const widths = titles.map((title, i) => Math.max(title.length, ...rows.map((row) => row[i]!.length)));
  const line = (cells: string[]) => cells.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").trimEnd();
  io.out(line(titles));
  for (const row of rows) io.out(line(row));
}

/** `files list|delete`. The bytes of a file are never printed; `--json` adds the checksum and the module's ref. */
export async function runFilesCommand(command: FilesCommand, deps: { pool: pg.Pool; registry: Registry; io: CliOutput }): Promise<void> {
  const { pool, registry, io } = deps;
  const service = new FileService(pool, registry, defaultFileStorage());
  if (command.action === "delete") {
    const [moduleId, id] = command.args as [string, string];
    const file = await service.stat(moduleId, id);
    if (file === null || !(await service.remove(moduleId, id))) throw new FileError(`module "${moduleId}" has no file "${id}"`);
    io.out(`deleted file ${id} (${moduleId} ${file.name})`);
    return;
  }
  const files = await service.listAll({
    ...(command.args[0] === undefined ? {} : { moduleId: command.args[0] }),
    ...(command.limit === undefined ? {} : { limit: command.limit }),
  });
  if (command.json) io.out(JSON.stringify(files, null, 2));
  else if (files.length === 0) io.out("no files");
  else printTable(files, io);
}
