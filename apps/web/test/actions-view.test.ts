import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CatalogEntry, Proposal } from "@modunexo/core/actions";
import { buildActionsView } from "../src/server/actions-view.ts";

const entry = (moduleId: string, key: string, risk: "read" | "write" | "sensitive", permission: string): CatalogEntry => ({
  moduleId, moduleName: moduleId.toUpperCase(), key, ref: `${moduleId}.${key}`,
  action: { key, label: `Label ${key}`, description: `Does ${key}.`, risk, permission, ...(risk === "read" ? { sql: "select 1" } : { job: key }), input: { n: { type: "int", min: 1, max: 9, required: true } } },
});
const proposal = (id: number, over: Partial<Proposal> = {}): Proposal => ({
  id, moduleId: "m", actionKey: "w", risk: "write", status: "pending", input: { n: 1 }, proposedBy: "mcp:laptop", proposedVia: "mcp", proposedAt: new Date("2026-11-24T10:00:00Z"),
  expiresAt: new Date("2026-12-01T10:00:00Z"), decidedBy: null, decidedAt: null, decisionNote: null, jobId: null, outcome: null, lastError: null, jobStatus: null, ...over,
});
const catalog = [entry("m", "r", "read", "m.read"), entry("m", "w", "write", "m.write"), entry("m", "s", "sensitive", "m.sensitive")];

describe("buildActionsView", () => {
  it("puts what waits for a decision first and the rest after it, newest first in each", () => {
    const view = buildActionsView({ catalog, proposals: [proposal(5, { status: "approved" }), proposal(4), proposal(3, { status: "rejected" }), proposal(6)], can: () => true });
    assert.deepEqual(view.waiting.map((row) => row.id), [6, 4]);
    assert.deepEqual(view.history.map((row) => row.id), [5, 3]);
  });

  it("lets a person decide only what they hold the permission for, and says so", () => {
    const view = buildActionsView({ catalog, proposals: [proposal(1), proposal(2, { actionKey: "s", risk: "sensitive" })], can: (permission) => permission === "m.write" });
    assert.deepEqual(view.waiting.map((row) => [row.id, row.canDecide]), [[2, false], [1, true]]);
  });

  it("names a proposal by its action's label, and by its reference when the module no longer offers it", () => {
    const view = buildActionsView({ catalog, proposals: [proposal(1), proposal(2, { actionKey: "gone" })], can: () => true });
    assert.deepEqual(view.waiting.map((row) => [row.label, row.canDecide]), [["m.gone", false], ["Label w", true]]);
  });

  it("shows the state a proposal is really in: its outcome once settled, else what the job is doing", () => {
    const view = buildActionsView({ catalog, proposals: [proposal(1, { status: "approved", jobStatus: "running" }), proposal(2, { status: "approved", outcome: "failed", lastError: "boom" }), proposal(3, { status: "approved", outcome: "executed" }), proposal(4, { status: "expired" })], can: () => true });
    assert.deepEqual(view.history.map((row) => row.state), ["expired", "executed", "failed", "approved (running)"]);
    assert.equal(view.history.find((row) => row.id === 2)?.error, "boom");
  });

  it("offers to run what the person may run, with the inputs to ask for, and nothing it may not", () => {
    const view = buildActionsView({ catalog, proposals: [], can: (permission) => permission !== "m.sensitive" });
    assert.deepEqual(view.runnable.map((row) => [row.ref, row.risk]), [["m.r", "read"], ["m.w", "write"]]);
    assert.deepEqual(view.runnable[0]!.inputs, [{ name: "n", type: "int", required: true, min: 1, max: 9 }]);
  });

  it("writes the input of a proposal as short readable text for the approver, cut when it is long", () => {
    const long = buildActionsView({ catalog, proposals: [proposal(1, { input: { text: "x".repeat(900) } })], can: () => true });
    assert.ok(long.waiting[0]!.input.length <= 400 && long.waiting[0]!.input.endsWith("…"));
    assert.equal(buildActionsView({ catalog, proposals: [proposal(1, { input: {} })], can: () => true }).waiting[0]!.input, "(nothing)");
  });
});
