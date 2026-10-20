import type pg from "pg";
import { EventService, type EventRecord } from "../events/index.ts";
import type { Registry } from "../registry.ts";
import type { CliOutput } from "./jobs.ts";

export interface EventsCommand {
  action: "publish" | "list";
  /** `publish`: module id and event name. `list`: an optional module id. */
  args: string[];
  payload: unknown;
  type: string | undefined;
  limit: number | undefined;
  json: boolean;
}

function printTable(records: EventRecord[], io: CliOutput): void {
  const when = (date: Date) => date.toISOString().slice(0, 19).replace("T", " ");
  const rows = records.map((r) => [String(r.id), r.moduleId, r.type, when(r.createdAt)]);
  const titles = ["ID", "MODULE", "TYPE", "CREATED"];
  const widths = titles.map((title, i) => Math.max(title.length, ...rows.map((row) => row[i]!.length)));
  const line = (cells: string[]) => cells.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").trimEnd();
  io.out(line(titles));
  for (const row of rows) io.out(line(row));
}

/** `events publish|list`. A payload appears only with `--json`, because a module may have put anything in it. */
export async function runEventsCommand(command: EventsCommand, deps: { pool: pg.Pool; registry: Registry; io: CliOutput }): Promise<void> {
  const { pool, registry, io } = deps;
  const service = new EventService(pool, registry);
  if (command.action === "publish") {
    const [moduleId, name] = command.args as [string, string];
    const { id } = await service.publish(moduleId, name, command.payload);
    io.out(`published event ${id} (${moduleId}.${name})`);
    return;
  }
  const records = await service.list({
    ...(command.args[0] === undefined ? {} : { moduleId: command.args[0] }),
    ...(command.type === undefined ? {} : { type: command.type }),
    ...(command.limit === undefined ? {} : { limit: command.limit }),
    withPayload: command.json,
  });
  if (command.json) io.out(JSON.stringify(records, null, 2));
  else if (records.length === 0) io.out("no events");
  else printTable(records, io);
}
