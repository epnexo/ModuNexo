import type pg from "pg";
import { ActionError, ActionService, type Actor, type Proposal, type ProposalStatus } from "../actions/index.ts";
import { moduleRolesFor } from "../data/module-roles.ts";
import type { Registry } from "../registry.ts";
import type { CliOutput } from "./jobs.ts";

export interface ActionsCommand {
  action: "list" | "run" | "propose" | "proposals" | "approve" | "reject";
  /** `run` and `propose`: the action as `<module>.<key>`. `approve` and `reject`: the proposal id. */
  args: string[];
  input: unknown;
  status: ProposalStatus | undefined;
  note: string | undefined;
  /** Who is recorded as having asked. The operator of this command holds every permission, so the name is only for the register. */
  actor: string;
  /** `mcp` when the command is run on behalf of an agent: it can read and propose, and never decide. */
  via: "cli" | "mcp";
  json: boolean;
}

const table = (titles: string[], rows: string[][], io: CliOutput) => {
  const widths = titles.map((title, i) => Math.max(title.length, ...rows.map((row) => row[i]!.length)));
  const line = (cells: string[]) => cells.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").trimEnd();
  io.out(line(titles));
  for (const row of rows) io.out(line(row));
};

const when = (date: Date | null) => (date === null ? "-" : date.toISOString().slice(0, 19).replace("T", " "));

/** `<module>.<key>`: a module id is kebab-case and has no dot, so the first dot ends it. */
function ref(text: string | undefined): { moduleId: string; key: string } {
  const dot = text === undefined ? -1 : text.indexOf(".");
  if (text === undefined || dot < 1 || dot === text.length - 1) throw new ActionError("unknown_action", `an action is named <module>.<key>, not "${text ?? ""}"`);
  return { moduleId: text.slice(0, dot), key: text.slice(dot + 1) };
}

/** Plain digits only, as the web routes and the jobs commands take them: "1e3" or "0x10" must never decide another proposal. */
function proposalId(text: string | undefined): number {
  if (text === undefined || !/^[1-9][0-9]{0,15}$/.test(text)) throw new ActionError("not_pending", `"${text ?? ""}" is not a proposal id`);
  return Number(text);
}

/** A proposal as the commands print it. The input is only in the JSON form, because it can be anything a person typed. */
const view = (proposal: Proposal, withInput: boolean) => ({
  id: proposal.id,
  action: `${proposal.moduleId}.${proposal.actionKey}`,
  risk: proposal.risk,
  status: proposal.outcome ?? proposal.status,
  proposedBy: proposal.proposedBy,
  proposedVia: proposal.proposedVia,
  proposedAt: proposal.proposedAt.toISOString(),
  expiresAt: proposal.expiresAt.toISOString(),
  decidedBy: proposal.decidedBy,
  decisionNote: proposal.decisionNote,
  jobId: proposal.jobId,
  jobStatus: proposal.jobStatus,
  lastError: proposal.lastError,
  ...(withInput ? { input: proposal.input } : {}),
});

/** `actions list|run|propose|proposals|approve|reject`: what the modules let an agent or a person do, and the register of what was asked. */
export async function runActionsCommand(command: ActionsCommand, deps: { pool: pg.Pool; registry: Registry; io: CliOutput; service?: ActionService }): Promise<void> {
  const { pool, registry, io } = deps;
  const service = deps.service ?? new ActionService(pool, registry, { moduleRoles: moduleRolesFor(pool) });
  const actor: Actor = { name: command.actor, via: command.via, can: () => true };

  if (command.action === "list") {
    const catalog = await service.catalog();
    if (command.json) {
      // The statement and the job are the module's own business: what an agent needs is what it may ask, with which inputs.
      io.out(JSON.stringify(catalog.map(({ ref: name, moduleId, moduleName, key, action }) => ({ ref: name, module: moduleId, moduleName, key, label: action.label, description: action.description, risk: action.risk, permission: action.permission, input: action.input ?? {} })), null, 2));
      return;
    }
    if (catalog.length === 0) return io.out("no module offers any action");
    table(["ACTION", "RISK", "PERMISSION", "WHAT IT DOES"], catalog.map((entry) => [entry.ref, entry.action.risk, entry.action.permission, entry.action.label]), io);
    return;
  }
  if (command.action === "run") {
    const result = await service.run(ref(command.args[0]), command.input, actor);
    if (result.kind === "rows") io.out(JSON.stringify(result.rows, null, command.json ? 2 : undefined));
    else io.out(`queued job ${result.jobId} (proposal ${result.proposalId}, approved by ${command.actor})`);
    return;
  }
  if (command.action === "propose") {
    const proposal = await service.propose(ref(command.args[0]), command.input, actor);
    io.out(command.json ? JSON.stringify(view(proposal, true), null, 2) : `proposal ${proposal.id} is waiting for a person (expires ${when(proposal.expiresAt)})`);
    return;
  }
  if (command.action === "proposals") {
    const proposals = await service.list({ ...(command.status === undefined ? {} : { status: command.status }) });
    // What a person typed into a proposal is for the people who decide it: an agent reading the register is not shown it.
    if (command.json) return io.out(JSON.stringify(proposals.map((proposal) => view(proposal, command.via !== "mcp")), null, 2));
    if (proposals.length === 0) return io.out("no proposals");
    table(["ID", "STATUS", "ACTION", "RISK", "BY", "EXPIRES"], proposals.map((proposal) => { const shown = view(proposal, false); return [String(shown.id), shown.status, shown.action, shown.risk, shown.proposedBy, when(proposal.expiresAt)]; }), io);
    return;
  }
  const id = proposalId(command.args[0]);
  const decided = command.action === "approve" ? await service.approve(id, actor) : await service.reject(id, actor, command.note);
  io.out(command.action === "approve" ? `proposal ${id} approved: job ${decided.jobId} queued` : `proposal ${id} rejected`);
}
