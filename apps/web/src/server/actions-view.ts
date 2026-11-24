import type { ActionDeclaration, ActionInput } from "@modunexo/sdk";
import type { CatalogEntry, Proposal } from "@modunexo/core/actions";

export interface InputView {
  name: string;
  type: ActionInput["type"];
  required: boolean;
  description?: string;
  maxLength?: number;
  min?: number;
  max?: number;
  values?: string[];
}

export interface RunnableView {
  ref: string;
  moduleName: string;
  label: string;
  description: string;
  risk: ActionDeclaration["risk"];
  inputs: InputView[];
}

export interface ProposalRow {
  id: number;
  ref: string;
  label: string;
  risk: "write" | "sensitive";
  proposedBy: string;
  proposedVia: string;
  proposedAt: string;
  expiresAt: string;
  /** What the approver is asked to approve, as short readable text. */
  input: string;
  /** Whether this person holds the permission the action needs. A proposal the module no longer offers cannot be decided. */
  canDecide: boolean;
  /** Where it stands: waiting, rejected, expired, or for an approved one what became of it. */
  state: string;
  decidedBy: string | null;
  decisionNote: string | null;
  error: string | null;
}

export interface ActionsView {
  waiting: ProposalRow[];
  history: ProposalRow[];
  runnable: RunnableView[];
}

const MAX_INPUT_CHARS = 400;

function inputText(input: Record<string, unknown>): string {
  const text = Object.entries(input).map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`).join("\n");
  if (text === "") return "(nothing)";
  return text.length > MAX_INPUT_CHARS ? `${text.slice(0, MAX_INPUT_CHARS - 1)}…` : text;
}

function stateOf(proposal: Proposal): string {
  if (proposal.status !== "approved") return proposal.status;
  if (proposal.outcome !== null) return proposal.outcome;
  return proposal.jobStatus === null ? "approved" : `approved (${proposal.jobStatus})`;
}

function inputViews(action: ActionDeclaration): InputView[] {
  return Object.entries(action.input ?? {}).map(([name, spec]) => ({
    name,
    type: spec.type,
    required: spec.required === true,
    ...(spec.description === undefined ? {} : { description: spec.description }),
    ...(spec.type === "text" ? { maxLength: spec.maxLength } : {}),
    ...(spec.type === "int" ? { min: spec.min, max: spec.max } : {}),
    ...(spec.type === "enum" ? { values: spec.values } : {}),
  }));
}

/**
 * What the actions screen shows one person: the proposals waiting for a decision (newest first) with what they may decide, the register
 * of what happened to the rest, and the actions they may run by hand with the inputs to ask for. Pure: the page and the tests feed it.
 */
export function buildActionsView(input: { catalog: CatalogEntry[]; proposals: Proposal[]; can: (permission: string) => boolean }): ActionsView {
  const byRef = new Map(input.catalog.map((entry) => [entry.ref, entry]));
  const row = (proposal: Proposal): ProposalRow => {
    const ref = `${proposal.moduleId}.${proposal.actionKey}`;
    const known = byRef.get(ref);
    const allowed = known !== undefined && input.can(known.action.permission);
    return {
      id: proposal.id,
      ref,
      label: known?.action.label ?? ref,
      risk: proposal.risk,
      proposedBy: proposal.proposedBy,
      proposedVia: proposal.proposedVia,
      proposedAt: proposal.proposedAt.toISOString(),
      expiresAt: proposal.expiresAt.toISOString(),
      input: allowed ? inputText(proposal.input) : "(hidden: you need the action's permission to see what it would do)",
      canDecide: allowed,
      state: stateOf(proposal),
      decidedBy: proposal.decidedBy,
      decisionNote: proposal.decisionNote,
      error: proposal.lastError,
    };
  };
  const newestFirst = [...input.proposals].sort((a, b) => b.id - a.id);
  return {
    waiting: newestFirst.filter((proposal) => proposal.status === "pending").map(row),
    history: newestFirst.filter((proposal) => proposal.status !== "pending").map(row),
    runnable: input.catalog
      .filter((entry) => input.can(entry.action.permission))
      .map((entry) => ({ ref: entry.ref, moduleName: entry.moduleName, label: entry.action.label, description: entry.action.description, risk: entry.action.risk, inputs: inputViews(entry.action) })),
  };
}
