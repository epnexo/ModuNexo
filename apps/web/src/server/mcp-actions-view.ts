import type { ActionDeclaration } from "@modunexo/sdk";
import type { CatalogEntry } from "@modunexo/core/actions";

export interface McpActionRow {
  ref: string;
  label: string;
  description: string;
  risk: ActionDeclaration["risk"];
  /** What the platform does with it when an agent asks: a read answers at once; anything that changes data waits for a person. */
  behaviour: "runs at once" | "waits for a person";
}

export interface McpActionsView {
  modules: { id: string; name: string; actions: McpActionRow[] }[];
  total: number;
  reads: number;
  changes: number;
  /** Proposals an agent left that no person has decided yet. */
  waiting: number;
  /** The catalog or the register could not be read, so the screen says so instead of claiming nothing is offered. */
  unavailable: boolean;
}

/** What Settings > MCP says about the actions the enabled modules offer an agent. Pure: the page and the tests feed it. */
export function buildMcpActionsView(input: { catalog: CatalogEntry[]; waiting: number }): McpActionsView {
  const modules: McpActionsView["modules"] = [];
  for (const entry of input.catalog) {
    let group = modules.find((candidate) => candidate.id === entry.moduleId);
    if (group === undefined) {
      group = { id: entry.moduleId, name: entry.moduleName, actions: [] };
      modules.push(group);
    }
    group.actions.push({
      ref: entry.ref,
      label: entry.action.label,
      description: entry.action.description,
      risk: entry.action.risk,
      behaviour: entry.action.risk === "read" ? "runs at once" : "waits for a person",
    });
  }
  const all = modules.flatMap((module) => module.actions);
  const reads = all.filter((action) => action.risk === "read").length;
  return { modules, total: all.length, reads, changes: all.length - reads, waiting: input.waiting, unavailable: false };
}

/** What Settings needs of the actions service, so a test can stand in for the database. */
export interface McpActionsSource {
  catalog: () => Promise<CatalogEntry[]>;
  list: (options: { status: "pending"; limit: number }) => Promise<{ expiresAt: Date }[]>;
}

/**
 * Reads the catalog and the waiting proposals for Settings > MCP. A failure of either leaves the page standing, with the block
 * saying it could not read them: one broken query must not take the whole Settings screen down, and nothing of the error is shown.
 */
export async function loadMcpActions(source: McpActionsSource, now: Date): Promise<McpActionsView> {
  try {
    const [catalog, pending] = await Promise.all([source.catalog(), source.list({ status: "pending", limit: 100 })]);
    return buildMcpActionsView({ catalog, waiting: pending.filter((proposal) => proposal.expiresAt.getTime() > now.getTime()).length });
  } catch {
    return { ...buildMcpActionsView({ catalog: [], waiting: 0 }), unavailable: true };
  }
}
