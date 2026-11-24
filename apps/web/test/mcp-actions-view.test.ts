import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CatalogEntry } from "@modunexo/core/actions";
import { buildMcpActionsView, loadMcpActions } from "../src/server/mcp-actions-view.ts";

const entry = (moduleId: string, key: string, risk: "read" | "write" | "sensitive"): CatalogEntry => ({
  moduleId, moduleName: moduleId.toUpperCase(), key, ref: `${moduleId}.${key}`,
  action: { key, label: `Label ${key}`, description: `Does ${key}.`, risk, permission: `${moduleId}.x`, ...(risk === "read" ? { sql: "select 1" } : { job: key }) },
});

describe("buildMcpActionsView", () => {
  it("says there is nothing to offer yet when no enabled module declares an action", () => {
    const view = buildMcpActionsView({ catalog: [], waiting: 0 });
    assert.deepEqual([view.modules, view.total, view.waiting, view.unavailable], [[], 0, 0, false]);
  });

  it("groups the actions by module, in the catalog's order, saying what happens to each: runs at once or waits for a person", () => {
    const view = buildMcpActionsView({ catalog: [entry("docs", "find", "read"), entry("docs", "archive", "write"), entry("crm", "close", "sensitive")], waiting: 2 });
    assert.deepEqual(view.modules.map((module) => [module.id, module.name, module.actions.map((action) => [action.ref, action.behaviour])]), [
      ["docs", "DOCS", [["docs.find", "runs at once"], ["docs.archive", "waits for a person"]]],
      ["crm", "CRM", [["crm.close", "waits for a person"]]],
    ]);
    assert.deepEqual([view.total, view.reads, view.changes, view.waiting], [3, 1, 2, 2]);
  });

  it("never offers more than it counts: a count is what the list holds", () => {
    const view = buildMcpActionsView({ catalog: [entry("a", "x", "read"), entry("a", "y", "write")], waiting: 0 });
    assert.equal(view.total, view.modules.flatMap((module) => module.actions).length);
    assert.equal(view.reads + view.changes, view.total);
  });
});

describe("loadMcpActions", () => {
  const proposal = (expiresAt: Date) => ({ expiresAt }) as never;

  it("counts only the proposals still inside their time as waiting", async () => {
    const now = new Date("2026-11-24T12:00:00Z");
    const view = await loadMcpActions(
      { catalog: async () => [entry("a", "x", "read")], list: async () => [proposal(new Date("2026-11-25T00:00:00Z")), proposal(new Date("2026-11-24T11:00:00Z"))] },
      now,
    );
    assert.deepEqual([view.total, view.waiting, view.unavailable], [1, 1, false]);
  });

  it("says it could not read them when the catalog or the register fails, instead of failing the page", async () => {
    const down = async () => {
      throw new Error("database is down");
    };
    for (const service of [{ catalog: down, list: async () => [] }, { catalog: async () => [], list: down }]) {
      const logged: { event: string; fields?: Record<string, unknown> }[] = [];
      const view = await loadMcpActions(service, new Date(), { warn: (event, fields) => void logged.push({ event, fields }) });
      assert.deepEqual([view.unavailable, view.total, view.waiting], [true, 0, 0]);
      assert.doesNotMatch(JSON.stringify(view), /database is down/);
      assert.equal(logged.length, 1, "the operator is told once, in the server's log, even though the page is not");
      assert.equal(logged[0]!.event, "settings.mcp_actions_failed");
      assert.match(String((logged[0]!.fields?.error as Error).message), /database is down/);
    }
  });
});
