import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CatalogEntry } from "@modunexo/core/actions";
import { buildMcpActionsView } from "../src/server/mcp-actions-view.ts";

const entry = (moduleId: string, key: string, risk: "read" | "write" | "sensitive"): CatalogEntry => ({
  moduleId, moduleName: moduleId.toUpperCase(), key, ref: `${moduleId}.${key}`,
  action: { key, label: `Label ${key}`, description: `Does ${key}.`, risk, permission: `${moduleId}.x`, ...(risk === "read" ? { sql: "select 1" } : { job: key }) },
});

describe("buildMcpActionsView", () => {
  it("says there is nothing to offer yet when no enabled module declares an action", () => {
    const view = buildMcpActionsView({ catalog: [], waiting: 0 });
    assert.deepEqual([view.modules, view.total, view.waiting], [[], 0, 0]);
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
