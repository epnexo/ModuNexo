import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GroupError } from "@modunexo/core/groups";
import { type GroupsDeps, handleAssign, handleCreate, handleList, handleRemove, handleUpdate } from "../src/server/groups-api.ts";

const ADMIN = { actor: "admin@example.test", canWrite: true };
const USER = { actor: "user@example.test", canWrite: false };
const GROUP = { id: 7, name: "Sales", position: 0, moduleCount: 0 };

interface Calls {
  create: string[];
  rename: [number, string][];
  move: [number, number][];
  remove: number[];
  assign: [string, number | null][];
}

function deps(overrides: Partial<GroupsDeps> = {}): { deps: GroupsDeps; calls: Calls } {
  const calls: Calls = { create: [], rename: [], move: [], remove: [], assign: [] };
  const base: GroupsDeps = {
    viewer: async () => ADMIN,
    service: {
      overview: async () => ({ groups: [GROUP], assignments: { crm: 7 } }),
      create: async (name) => (calls.create.push(name), { ...GROUP, name }),
      rename: async (id, name) => (calls.rename.push([id, name]), { ...GROUP, id, name }),
      move: async (id, position) => (calls.move.push([id, position]), [GROUP]),
      remove: async (id) => void calls.remove.push(id),
      assign: async (moduleId, groupId) => void calls.assign.push([moduleId, groupId]),
    },
  };
  return { deps: { ...base, ...overrides }, calls };
}

const same = { origin: "http://h", host: "h" };
const send = (method: string, body?: unknown, headers: Record<string, string> = same) =>
  new Request("http://h/api/groups", { method, headers, body: body === undefined ? null : JSON.stringify(body) });

describe("groups API: who may ask", () => {
  it("refuses a cross-origin write, a visitor who is not signed in and a person who is not an administrator", async () => {
    const { deps: d, calls } = deps();
    assert.equal((await handleCreate(send("POST", { name: "A" }, { origin: "http://evil", host: "h" }), d)).status, 403);
    assert.equal((await handleCreate(send("POST", { name: "A" }), deps({ viewer: async () => null }).deps)).status, 401);
    assert.equal((await handleCreate(send("POST", { name: "A" }), deps({ viewer: async () => USER }).deps)).status, 403);
    assert.equal((await handleList(send("GET"), deps({ viewer: async () => USER }).deps)).status, 403);
    assert.deepEqual(calls.create, []);
  });
});

describe("groups API: list, create, rename, move, delete, assign", () => {
  it("lists the groups and which module sits in which", async () => {
    const response = await handleList(send("GET", undefined, {}), deps().deps);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { groups: [GROUP], assignments: { crm: 7 } });
  });

  it("creates a group from { name }", async () => {
    const { deps: d, calls } = deps();
    const response = await handleCreate(send("POST", { name: "Support" }), d);
    assert.equal(response.status, 201);
    assert.deepEqual(calls.create, ["Support"]);
    assert.equal(((await response.json()) as { group: { name: string } }).group.name, "Support");
  });

  it("renames and moves a group in one request, and refuses what is not an update", async () => {
    const { deps: d, calls } = deps();
    assert.equal((await handleUpdate(send("PATCH", { name: "Revenue", position: 2 }), 7, d)).status, 200);
    assert.deepEqual(calls.rename, [[7, "Revenue"]]);
    assert.deepEqual(calls.move, [[7, 2]]);
    assert.equal((await handleUpdate(send("PATCH", {}), 7, d)).status, 400);
    assert.equal((await handleUpdate(send("PATCH", { position: "first" }), 7, d)).status, 400);
    assert.equal((await handleUpdate(send("PATCH", { name: 3 }), 7, d)).status, 400);
    assert.equal((await handleUpdate(send("PATCH", { colour: "red" }), 7, d)).status, 400);
  });

  it("deletes a group", async () => {
    const { deps: d, calls } = deps();
    assert.equal((await handleRemove(send("DELETE"), 7, d)).status, 200);
    assert.deepEqual(calls.remove, [7]);
  });

  it("assigns a module to a group, or takes it out with null, and refuses anything else", async () => {
    const { deps: d, calls } = deps();
    assert.equal((await handleAssign(send("POST", { moduleId: "crm", groupId: 7 }), d)).status, 200);
    assert.equal((await handleAssign(send("POST", { moduleId: "crm", groupId: null }), d)).status, 200);
    assert.deepEqual(calls.assign, [["crm", 7], ["crm", null]]);
    assert.equal((await handleAssign(send("POST", { moduleId: "crm" }), d)).status, 400);
    assert.equal((await handleAssign(send("POST", { moduleId: "crm", groupId: "7" }), d)).status, 400);
    assert.equal((await handleAssign(send("POST", { moduleId: 5, groupId: 7 }), d)).status, 400);
    assert.equal((await handleAssign(send("POST", { moduleId: "crm", groupId: 1e30 }), d)).status, 400);
    assert.equal((await handleAssign(send("POST", { moduleId: "crm", groupId: 0 }), d)).status, 400);
    assert.equal((await handleUpdate(send("PATCH", { position: 1e30 }), 7, d)).status, 400);
    assert.equal(calls.assign.length, 2);
  });

  it("answers the service's refusals with the status that fits, and a message the person can read", async () => {
    const refuse = (code: GroupError["code"]) =>
      deps({ service: { ...deps().deps.service, create: async () => { throw new GroupError(code, `refused: ${code}`); } } }).deps;
    for (const [code, status] of [["invalid-name", 400], ["duplicate", 409], ["not-found", 404], ["module-not-installed", 404]] as const) {
      const response = await handleCreate(send("POST", { name: "A" }), refuse(code));
      assert.equal(response.status, status);
      assert.equal(((await response.json()) as { error: string }).error, `refused: ${code}`);
    }
  });

  it("refuses a body that is not an object or not JSON", async () => {
    const { deps: d } = deps();
    assert.equal((await handleCreate(send("POST", [1]), d)).status, 400);
    assert.equal((await handleCreate(new Request("http://h/x", { method: "POST", headers: same, body: "{nope" }), d)).status, 400);
  });
});
