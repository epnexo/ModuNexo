import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ActionError, type Actor, type Proposal } from "@modunexo/core/actions";
import { type ActionsDeps, handleApprove, handleReject, handleRunAction } from "../src/server/actions-api.ts";

const ORIGIN = "https://crm.example.test";
const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  id: 7, moduleId: "documents", actionKey: "archive_template", risk: "write", status: "approved", input: { template: 3 }, proposedBy: "mcp:laptop", proposedVia: "mcp",
  proposedAt: new Date("2026-11-24T10:00:00Z"), expiresAt: new Date("2026-12-01T10:00:00Z"), decidedBy: "boss@example.test", decidedAt: new Date("2026-11-24T11:00:00Z"),
  decisionNote: null, jobId: 12, outcome: null, lastError: null, jobStatus: "queued", ...over,
});

function harness(options: { viewer?: "admin" | "reader" | null; fail?: ActionError } = {}) {
  const calls: { method: string; args: unknown[]; actor?: Actor }[] = [];
  const maybeFail = () => {
    if (options.fail !== undefined) throw options.fail;
  };
  const deps: ActionsDeps = {
    viewer: async () => (options.viewer === null ? null : { actor: options.viewer === "reader" ? "reader@example.test" : "boss@example.test", can: (permission) => options.viewer !== "reader" || permission === "documents.read" }),
    service: {
      run: async (ref, input, actor) => {
        calls.push({ method: "run", args: [ref, input], actor });
        maybeFail();
        return ref.key === "find_templates" ? { kind: "rows" as const, rows: [{ id: 1 }] } : { kind: "queued" as const, proposalId: 7, jobId: 12 };
      },
      approve: async (id, actor) => {
        calls.push({ method: "approve", args: [id], actor });
        maybeFail();
        return proposal();
      },
      reject: async (id, actor, note) => {
        calls.push({ method: "reject", args: [id, note], actor });
        maybeFail();
        return proposal({ status: "rejected", jobId: null, jobStatus: null, decisionNote: note ?? null });
      },
    },
  };
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    new Request(`${ORIGIN}${path}`, { method: "POST", headers: { origin: ORIGIN, host: "crm.example.test", "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { deps, calls, post };
}
const body = async (response: Response) => (await response.json()) as Record<string, unknown>;

describe("who may use the actions API", () => {
  it("answers 401 to nobody and 403 to another site, before reading anything", async () => {
    const h = harness({ viewer: null });
    assert.equal((await handleApprove(h.post("/x", {}), 7, h.deps)).status, 401);
    const other = harness();
    assert.equal((await handleApprove(other.post("/x", {}, { origin: "https://evil.example" }), 7, other.deps)).status, 403);
    assert.equal(other.calls.length, 0);
  });

  it("hands the service the person as the actor, on the portal's channel, with what they may do", async () => {
    const h = harness({ viewer: "reader" });
    await handleRunAction(h.post("/x", { action: "documents.find_templates" }), h.deps);
    const actor = h.calls[0]!.actor!;
    assert.deepEqual([actor.name, actor.via, actor.can("documents.read"), actor.can("documents.write")], ["reader@example.test", "portal", true, false]);
  });
});

describe("running an action by hand", () => {
  it("returns the rows of a read, and the job of a write run as the person", async () => {
    const h = harness();
    const read = await handleRunAction(h.post("/x", { action: "documents.find_templates", input: { q: "nda" } }), h.deps);
    assert.deepEqual(await body(read), { kind: "rows", rows: [{ id: 1 }] });
    assert.deepEqual(h.calls[0]!.args, [{ moduleId: "documents", key: "find_templates" }, { q: "nda" }]);
    const write = await handleRunAction(h.post("/x", { action: "documents.archive_template", input: { template: 3 } }), h.deps);
    assert.deepEqual(await body(write), { kind: "queued", proposalId: 7, jobId: 12 });
  });

  it("refuses a body that is not { action: <module>.<key>, input? } before running anything", async () => {
    const h = harness();
    for (const bad of [{}, { action: 5 }, { action: "nodots" }, { action: ".x" }, { action: "m.k", extra: 1 }, { action: "m.k", input: [] }, { action: "m.k", input: "x" }, "not json", []]) {
      assert.equal((await handleRunAction(h.post("/x", bad), h.deps)).status, 400, JSON.stringify(bad));
    }
    assert.equal(h.calls.length, 0);
  });

  it("turns what the service refuses into the status that says it, with a message safe to show", async () => {
    const codes: Record<string, number> = { unknown_action: 404, disabled: 409, forbidden: 403, invalid_input: 400, not_proposable: 400, needs_approval: 400, too_many_pending: 429, not_pending: 409, self_approval: 403, failed: 502 };
    for (const [code, status] of Object.entries(codes)) {
      const h = harness({ fail: new ActionError(code as never, `because ${code}`) });
      const response = await handleRunAction(h.post("/x", { action: "m.k" }), h.deps);
      assert.equal(response.status, status, code);
      assert.deepEqual(await body(response), { error: `because ${code}`, code });
    }
  });
});

describe("deciding a proposal", () => {
  it("approves by id, and says what became of it, never the input", async () => {
    const h = harness();
    const response = await handleApprove(h.post("/x", {}), 7, h.deps);
    assert.equal(response.status, 200);
    const answer = await body(response);
    assert.deepEqual(answer.proposal, { id: 7, status: "approved", decidedBy: "boss@example.test", jobId: 12 });
    assert.deepEqual(h.calls[0]!.args, [7]);
  });

  it("rejects with an optional note, cut to what fits, and refuses a body with anything else", async () => {
    const h = harness();
    assert.equal((await handleReject(h.post("/x", { note: "not this week" }), 7, h.deps)).status, 200);
    assert.equal((await handleReject(h.post("/x", {}), 7, h.deps)).status, 200);
    assert.deepEqual(h.calls.map((call) => call.args), [[7, "not this week"], [7, undefined]]);
    assert.equal((await handleReject(h.post("/x", { note: 5 }), 7, h.deps)).status, 400);
    assert.equal((await handleReject(h.post("/x", { note: "x", other: 1 }), 7, h.deps)).status, 400);
    assert.equal((await handleReject(h.post("/x", { note: "x".repeat(400) }), 7, h.deps)).status, 400);
  });

  it("takes only a proposal id, never 1e0 or 0x1 or zero", async () => {
    const h = harness();
    for (const id of [Number.NaN, 0, -1, 1.5, 2 ** 60]) assert.equal((await handleApprove(h.post("/x", {}), id, h.deps)).status, 404, String(id));
    assert.equal(h.calls.length, 0);
  });
});
