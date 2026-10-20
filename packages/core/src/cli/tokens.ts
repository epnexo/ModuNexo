import type pg from "pg";
import type { Registry } from "../registry.ts";
import { TokenService, type TokenRecord } from "../tokens/service.ts";

export interface TokensCommand {
  action: "create" | "list" | "revoke";
  /** `create`: the module id. `list`: an optional module id. `revoke`: the token id. */
  args: string[];
  name: string | undefined;
  scopes: string[];
  expiresInDays: number | undefined;
  json: boolean;
}

export interface TokensCommandDeps {
  pool: pg.Pool;
  registry: Registry;
  io: { out: (line: string) => void; err: (line: string) => void };
}

const ACTOR = "cli";
const DAY_MS = 86_400_000;

function stateOf(record: TokenRecord, now: Date): "active" | "revoked" | "expired" {
  if (record.revokedAt !== null) return "revoked";
  if (record.expiresAt !== null && record.expiresAt.getTime() <= now.getTime()) return "expired";
  return "active";
}

const day = (date: Date | null) => (date === null ? "-" : date.toISOString().slice(0, 10));

function printTable(records: TokenRecord[], io: TokensCommandDeps["io"]): void {
  const now = new Date();
  const rows = records.map((r) => [String(r.id), r.moduleId, r.name, r.prefix, r.scopes.join(","), stateOf(r, now), day(r.expiresAt), day(r.lastUsedAt)]);
  const titles = ["ID", "MODULE", "NAME", "PREFIX", "SCOPES", "STATE", "EXPIRES", "LAST USED"];
  const widths = titles.map((title, i) => Math.max(title.length, ...rows.map((row) => row[i]!.length)));
  const line = (cells: string[]) => cells.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").trimEnd();
  io.out(line(titles));
  for (const row of rows) io.out(line(row));
}

/**
 * `tokens create|list|revoke`. A token is printed once, on standard output and nothing else, so a pipe can capture
 * it; the reminder goes to standard error. Nothing the platform keeps can print a token again.
 */
export async function runTokensCommand(command: TokensCommand, { pool, registry, io }: TokensCommandDeps): Promise<void> {
  const service = new TokenService(pool, registry);
  if (command.action === "create") {
    const [moduleId] = command.args as [string];
    const expiresAt = command.expiresInDays === undefined ? undefined : new Date(Date.now() + command.expiresInDays * DAY_MS);
    const { record, token } = await service.create({ moduleId, name: command.name!, scopes: command.scopes, ...(expiresAt === undefined ? {} : { expiresAt }), actor: ACTOR });
    io.err(`created token ${record.id} for ${moduleId} (${record.scopes.join(", ")}). It is shown once: store it now, it cannot be shown again.`);
    io.out(token);
    return;
  }
  if (command.action === "list") {
    const records = await service.list(command.args[0]);
    if (command.json) io.out(JSON.stringify(records, null, 2));
    else if (records.length === 0) io.out("no tokens");
    else printTable(records, io);
    return;
  }
  const record = await service.revoke(Number(command.args[0]), ACTOR);
  io.out(`revoked token ${record.id} (${record.moduleId}, ${record.name})`);
}
