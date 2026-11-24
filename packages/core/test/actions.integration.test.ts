import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import type pg from "pg";
import type { ActionDeclaration } from "@modunexo/sdk";
import { ActionError, ActionService, type Actor } from "../src/actions/index.ts";
import { runActionsCommand, type ActionsCommand } from "../src/cli/actions.ts";
import { type CliIo, runCli } from "../src/cli/run.ts";
import { moduleRolesFor } from "../src/data/module-roles.ts";
import { migrate } from "../src/runner.ts";
import { createPool } from "../src/pool.ts";
import { createScratchDatabase } from "../src/testing.ts";
import { Sandbox } from "./sandbox.ts";

let pool: pg.Pool | undefined;
let skipReason: string | undefined;
let dropScratch: (() => Promise<void>) | undefined;
let box: Sandbox;
let moduleId: string;
let offId: string;
let service: ActionService;
let clock = new Date("2026-11-24T12:00:00Z");
const advance = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};
const DAY = 86_400_000;

const person = (name: string, permissions: string[] | "all" = "all"): Actor => ({ name, via: "portal", can: (permission) => permissions === "all" || permissions.includes(permission) });
const agent = (name = "agent:mcp"): Actor => ({ name, via: "mcp", can: () => false });
const perm = (suffix: string) => `acts.${suffix}`;

before(async () => {
  const scratch = await createScratchDatabase();
  if (!scratch.url) {
    skipReason = scratch.skipReason;
    return;
  }
  dropScratch = scratch.drop;
  pool = createPool(scratch.url);
  box = new Sandbox(pool);
  const mod = box.add();
  moduleId = mod.manifest.id;
  mod.write("0001_init.sql", "create table notes (id serial primary key, body text not null, n int not null default 0);");
  const actions: ActionDeclaration[] = [
    { key: "find_notes", label: "Find notes", description: "Notes whose text contains the given text.", risk: "read", permission: "acts.read", input: { text: { type: "text", maxLength: 50, required: true } }, sql: "select id, body from notes where body ilike '%' || $1 || '%' order by id" },
    { key: "all_notes", label: "All notes", description: "Every note.", risk: "read", permission: "acts.read", sql: "select id, body from notes order by id" },
    { key: "broken", label: "Broken", description: "A statement that fails.", risk: "read", permission: "acts.read", sql: "select 1 / 0 as boom" },
    { key: "many", label: "Many", description: "A million rows.", risk: "read", permission: "acts.read", sql: "select g as n from generate_series(1, 1000000) g order by g" },
    { key: "add_note", label: "Add a note", description: "Adds a note.", risk: "write", permission: "acts.write", input: { text: { type: "text", maxLength: 100, required: true } }, job: "add_note" },
    { key: "close_deal", label: "Close a deal", description: "Marks a deal as won.", risk: "sensitive", permission: "acts.close", job: "close_deal" },
  ];
  mod.manifest.permissions = ["read", "write", "close"].map((suffix) => ({ key: `acts.${suffix}`, label: suffix }));
  mod.manifest.jobs = [{ name: "add_note", entry: "./jobs/add-note.ts" }, { name: "close_deal", entry: "./jobs/close-deal.ts" }];
  mod.manifest.actions = actions;
  const off = box.add();
  offId = off.manifest.id;
  off.manifest.permissions = [{ key: "actsoff.write", label: "w" }];
  off.manifest.jobs = [{ name: "j", entry: "./jobs/j.ts" }];
  off.manifest.actions = [{ key: "do_it", label: "Do it", description: "Does it.", risk: "write", permission: "actsoff.write", job: "j" }];
  const registry = box.registry();
  await migrate(pool, registry, { moduleRoles: moduleRolesFor(pool) });
  await pool.query("insert into core.modules (id, state, installed_version) values ($1, 'enabled', '1.0.0'), ($2, 'disabled', '1.0.0')", [moduleId, offId]);
  service = new ActionService(pool, registry, { now: () => clock, moduleRoles: moduleRolesFor(pool), maxPending: 4 });
});

after(async () => {
  if (pool) {
    await pool.query("delete from core.action_proposals");
    await pool.query("delete from core.jobs where module_id = $1", [moduleId]);
    await pool.query("delete from core.events where type like 'core.action.%'");
    await box.cleanup();
    await pool.end();
  }
  await dropScratch?.();
});

beforeEach(async () => {
  if (!pool) return;
  clock = new Date("2026-11-24T12:00:00Z");
  await pool.query("delete from core.action_proposals");
  await pool.query("delete from core.jobs where module_id = $1", [moduleId]);
  await pool.query("delete from core.events where type like 'core.action.%'");
  await pool.query(`delete from ${box.modules[0]!.manifest.schema}.notes`).catch(() => undefined);
});

const test = (name: string, run: () => Promise<void>) =>
  it(name, async (t) => {
    if (!pool) return t.skip(skipReason);
    await run();
  });
const rejects = (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (error: unknown) => error instanceof ActionError && error.code === code, `expected ActionError ${code}`);
const events = async () => (await pool!.query("select type, payload from core.events where type like 'core.action.%' order by id")).rows as { type: string; payload: Record<string, unknown> }[];
const jobs = async () => (await pool!.query("select name, payload, enqueued_by, status from core.jobs where module_id = $1 order by id", [moduleId])).rows as { name: string; payload: unknown; enqueued_by: string; status: string }[];
const seedNotes = async () => {
  const schema = box.modules[0]!.manifest.schema;
  await pool!.query(`insert into ${schema}.notes (body) values ('call Ada'), ('email Bob'), ('call Cy')`);
};

describe("the catalog", () => {
  test("lists the actions of the enabled modules, each with its module and reference, and none of a disabled one", async () => {
    const catalog = await service.catalog();
    const mine = catalog.filter((entry) => entry.moduleId === moduleId);
    assert.deepEqual(mine.map((entry) => entry.ref), [`${moduleId}.find_notes`, `${moduleId}.all_notes`, `${moduleId}.broken`, `${moduleId}.many`, `${moduleId}.add_note`, `${moduleId}.close_deal`]);
    assert.equal(mine.find((entry) => entry.key === "add_note")?.action.risk, "write");
    assert.equal(catalog.some((entry) => entry.moduleId === offId), false, "a disabled module offers nothing");
    assert.equal(catalog.some((entry) => entry.moduleId === "core"), false);
  });
});

describe("a read action", () => {
  test("runs at once as the module's read-only statement, with the input bound to $1, for a person who holds its permission", async () => {
    await seedNotes();
    const result = await service.run({ moduleId, key: "find_notes" }, { text: "call" }, person("ada@example.test"));
    assert.equal(result.kind, "rows");
    if (result.kind === "rows") assert.deepEqual(result.rows.map((row) => row.body), ["call Ada", "call Cy"]);
    assert.equal((await pool!.query("select count(*)::int as n from core.action_proposals")).rows[0].n, 0, "a read leaves no proposal");
  });

  test("never builds the statement from the input: a value that looks like SQL is only a value", async () => {
    await seedNotes();
    const result = await service.run({ moduleId, key: "find_notes" }, { text: "x'; drop table notes; --" }, person("ada@example.test"));
    assert.equal(result.kind === "rows" && result.rows.length, 0);
    assert.equal((await pool!.query(`select count(*)::int as n from ${box.modules[0]!.manifest.schema}.notes`)).rows[0].n, 3);
  });

  test("refuses a caller without the permission, an unknown action, a disabled module and a bad input, and says nothing about a failing statement", async () => {
    await rejects(service.run({ moduleId, key: "all_notes" }, {}, person("x", [perm("write")])), "forbidden");
    await rejects(service.run({ moduleId, key: "all_notes" }, {}, agent()), "forbidden");
    await rejects(service.run({ moduleId, key: "nope" }, {}, person("x")), "unknown_action");
    await rejects(service.run({ moduleId: offId, key: "do_it" }, {}, person("x")), "disabled");
    await rejects(service.run({ moduleId, key: "find_notes" }, {}, person("x")), "invalid_input");
    await assert.rejects(service.run({ moduleId, key: "broken" }, {}, person("x")), (error: unknown) => error instanceof ActionError && error.code === "failed" && !/division|zero|1 \/ 0/i.test(error.message));
  });
});

describe("what a read action may cost", () => {
  test("returns at most one hundred rows and does not pull the rest into the server", async () => {
    const started = Date.now();
    const result = await service.run({ moduleId, key: "many" }, {}, person("ada@example.test"));
    assert.equal(result.kind === "rows" && result.rows.length, 100);
    assert.deepEqual(result.kind === "rows" && result.rows.slice(0, 2).map((row) => row.n), [1, 2], "the statement's own order is kept");
    assert.ok(Date.now() - started < 3000, "bounded by the limit, not by the size of the table");
  });
});

describe("a person running a write action in the portal", () => {
  test("is the decision itself: the job is queued at once with the input as its payload, and the register shows who", async () => {
    const result = await service.run({ moduleId, key: "add_note" }, { text: "hello" }, person("ada@example.test"));
    assert.equal(result.kind, "queued");
    assert.deepEqual((await jobs()).map((job) => [job.name, job.payload, job.status]), [["add_note", { text: "hello" }, "queued"]]);
    const [row] = (await pool!.query("select * from core.action_proposals")).rows;
    assert.equal(row.status, "approved");
    assert.equal(row.proposed_via, "portal");
    assert.equal(row.proposed_by, "ada@example.test");
    assert.equal(row.decided_by, "ada@example.test");
    assert.ok(row.job_id);
    assert.deepEqual((await events()).map((event) => event.type), ["core.action.approved"]);
  });

  test("needs the action's own permission, and writes nothing when refused", async () => {
    await rejects(service.run({ moduleId, key: "add_note" }, { text: "x" }, person("x", [perm("read")])), "forbidden");
    await rejects(service.run({ moduleId, key: "close_deal" }, {}, person("x", [perm("write")])), "forbidden");
    assert.equal((await jobs()).length, 0);
    assert.equal((await pool!.query("select count(*)::int as n from core.action_proposals")).rows[0].n, 0);
  });
});

describe("an agent proposing", () => {
  test("leaves a pending proposal that expires in seven days, with the caller's identity and the input, and runs nothing", async () => {
    const proposal = await service.propose({ moduleId, key: "add_note" }, { text: "from the agent" }, agent("claude-laptop"));
    assert.equal(proposal.status, "pending");
    assert.equal(proposal.proposedBy, "claude-laptop");
    assert.equal(proposal.proposedVia, "mcp");
    assert.deepEqual(proposal.input, { text: "from the agent" });
    assert.equal(proposal.expiresAt.getTime(), clock.getTime() + 7 * DAY);
    assert.equal((await jobs()).length, 0, "nothing runs until a person approves");
    assert.deepEqual((await events()).map((event) => event.type), ["core.action.proposed"]);
  });

  test("never puts the input in an event, which is read by more than the approver", async () => {
    await service.propose({ moduleId, key: "add_note" }, { text: "SECRET-TEXT-123" }, agent());
    assert.doesNotMatch(JSON.stringify(await events()), /SECRET-TEXT-123/);
    const [event] = await events();
    assert.deepEqual(Object.keys(event!.payload).sort(), ["action", "id", "module", "proposedBy", "risk"]);
  });

  test("never lets more proposals wait than the limit, even when they all arrive at the same moment", async () => {
    const outcomes = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => service.propose({ moduleId, key: "add_note" }, { text: `race ${i}` }, agent(`agent-${i}`))));
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 4);
    assert.equal(outcomes.filter((outcome) => outcome.status === "rejected" && (outcome.reason as ActionError).code === "too_many_pending").length, 6);
    assert.equal((await pool!.query("select count(*)::int as n from core.action_proposals where status = 'pending'")).rows[0].n, 4);
  });

  test("refuses a read action (it runs), a bad input, an unknown or disabled action, and more pending than the limit", async () => {
    await rejects(service.propose({ moduleId, key: "all_notes" }, {}, agent()), "not_proposable");
    await rejects(service.propose({ moduleId, key: "add_note" }, { text: 5 }, agent()), "invalid_input");
    await rejects(service.propose({ moduleId, key: "nope" }, {}, agent()), "unknown_action");
    await rejects(service.propose({ moduleId: offId, key: "do_it" }, {}, agent()), "disabled");
    for (let i = 0; i < 4; i++) await service.propose({ moduleId, key: "add_note" }, { text: `n${i}` }, agent());
    await rejects(service.propose({ moduleId, key: "add_note" }, { text: "one more" }, agent()), "too_many_pending");
  });
});

describe("approving and rejecting", () => {
  test("approving queues the job with the proposed input, once, and records who decided and which job", async () => {
    const proposal = await service.propose({ moduleId, key: "add_note" }, { text: "approve me" }, agent());
    const approved = await service.approve(proposal.id, person("boss@example.test"));
    assert.equal(approved.status, "approved");
    assert.equal(approved.decidedBy, "boss@example.test");
    assert.ok(approved.jobId);
    const queued = await jobs();
    assert.deepEqual(queued.map((job) => [job.name, job.payload, job.enqueued_by]), [["add_note", { text: "approve me" }, `action:${proposal.id}`]]);
    await rejects(service.approve(proposal.id, person("boss@example.test")), "not_pending");
    assert.equal((await jobs()).length, 1, "a second approval cannot queue it again");
    assert.deepEqual((await events()).map((event) => event.type), ["core.action.proposed", "core.action.approved"]);
  });

  test("tells a caller without the permission nothing about the proposal: not whether it is still waiting", async () => {
    const proposal = await service.propose({ moduleId, key: "add_note" }, { text: "x" }, agent());
    await service.approve(proposal.id, person("boss@example.test"));
    await rejects(service.approve(proposal.id, person("x", [perm("read")])), "forbidden");
    await rejects(service.reject(proposal.id, agent("another")), "forbidden");
  });

  test("needs the action's permission, and an agent can never approve", async () => {
    const proposal = await service.propose({ moduleId, key: "close_deal" }, {}, agent());
    await rejects(service.approve(proposal.id, person("x", [perm("write")])), "forbidden");
    await rejects(service.approve(proposal.id, agent("other-agent")), "forbidden");
    assert.equal((await service.get(proposal.id))?.status, "pending");
    assert.equal((await jobs()).length, 0);
  });

  test("never takes a decision that arrives through an agent's channel, whoever it says it is and whatever it holds", async () => {
    const proposal = await service.propose({ moduleId, key: "add_note" }, { text: "x" }, agent());
    const viaMcp: Actor = { name: "boss@example.test", via: "mcp", can: () => true };
    await rejects(service.approve(proposal.id, viaMcp), "forbidden");
    await rejects(service.reject(proposal.id, viaMcp), "forbidden");
    assert.equal((await service.get(proposal.id))?.status, "pending");
    assert.equal((await jobs()).length, 0);
  });

  test("cannot be approved by the identity that proposed it", async () => {
    const proposal = await service.propose({ moduleId, key: "add_note" }, { text: "mine" }, { name: "ada@example.test", via: "portal", can: () => true });
    await rejects(service.approve(proposal.id, person("ada@example.test")), "self_approval");
  });

  test("refuses an expired proposal and marks it expired", async () => {
    const proposal = await service.propose({ moduleId, key: "add_note" }, { text: "late" }, agent());
    advance(7 * DAY + 1000);
    await rejects(service.approve(proposal.id, person("boss@example.test")), "not_pending");
    assert.equal((await service.get(proposal.id))?.status, "expired");
    assert.equal((await jobs()).length, 0);
  });

  test("rejecting records who and why, runs nothing, and needs the permission too", async () => {
    const proposal = await service.propose({ moduleId, key: "add_note" }, { text: "no" }, agent());
    await rejects(service.reject(proposal.id, person("x", [perm("read")])), "forbidden");
    const rejected = await service.reject(proposal.id, person("boss@example.test"), "not this week");
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.decidedBy, "boss@example.test");
    assert.equal(rejected.decisionNote, "not this week");
    assert.equal((await jobs()).length, 0);
    await rejects(service.reject(proposal.id, person("boss@example.test")), "not_pending");
  });

  test("leaves the proposal pending when the job cannot be queued, as when its module was disabled meanwhile", async () => {
    const proposal = await service.propose({ moduleId, key: "add_note" }, { text: "x" }, agent());
    await pool!.query("update core.modules set state = 'disabled' where id = $1", [moduleId]);
    try {
      await assert.rejects(service.approve(proposal.id, person("boss@example.test")));
      assert.equal((await service.get(proposal.id))?.status, "pending");
      assert.equal((await jobs()).length, 0);
    } finally {
      await pool!.query("update core.modules set state = 'enabled' where id = $1", [moduleId]);
    }
  });

  test("refuses a proposal whose action the module no longer declares", async () => {
    const proposal = await service.propose({ moduleId, key: "add_note" }, { text: "x" }, agent());
    await pool!.query("update core.action_proposals set action_key = 'gone' where id = $1", [proposal.id]);
    await rejects(service.approve(proposal.id, person("boss@example.test")), "unknown_action");
  });
});

describe("expiry and outcome", () => {
  test("expires what is due, once, with an event each, and leaves the rest", async () => {
    const old = await service.propose({ moduleId, key: "add_note" }, { text: "old" }, agent());
    advance(5 * DAY);
    const fresh = await service.propose({ moduleId, key: "add_note" }, { text: "fresh" }, agent());
    advance(3 * DAY);
    assert.equal(await service.expireDue(), 1);
    assert.equal(await service.expireDue(), 0, "nothing is expired twice");
    assert.equal((await service.get(old.id))?.status, "expired");
    assert.equal((await service.get(fresh.id))?.status, "pending");
    assert.equal((await events()).filter((event) => event.type === "core.action.expired").length, 1);
  });

  test("keeps a state change and its event together: when the event cannot be written, nothing is expired or settled", async () => {
    const waiting = await service.propose({ moduleId, key: "add_note" }, { text: "w" }, agent());
    advance(8 * DAY);
    await pool!.query("alter table core.events add constraint no_expired_events check (type <> 'core.action.expired') not valid");
    try {
      await assert.rejects(service.expireDue());
    } finally {
      await pool!.query("alter table core.events drop constraint no_expired_events");
    }
    assert.equal((await service.get(waiting.id))?.status, "pending", "the proposal was not expired without its event");
    assert.equal(await service.expireDue(), 1, "and it is expired, with its event, once the event can be written");
    assert.equal((await events()).filter((event) => event.type === "core.action.expired").length, 1);

    clock = new Date("2026-11-24T12:00:00Z");
    const done = await service.propose({ moduleId, key: "add_note" }, { text: "d" }, agent());
    const job = (await service.approve(done.id, person("boss@example.test"))).jobId;
    await pool!.query("update core.jobs set status = 'succeeded', finished_at = now() where id = $1", [job]);
    await pool!.query("alter table core.events add constraint no_executed_events check (type <> 'core.action.executed') not valid");
    try {
      await assert.rejects(service.settle());
    } finally {
      await pool!.query("alter table core.events drop constraint no_executed_events");
    }
    assert.equal((await service.get(done.id))?.outcome, null, "it is not settled without its event");
    assert.equal(await service.settle(), 1);
  });

  test("settles an approved action once its job finished: executed or failed with the job's error, an event each, never twice", async () => {
    const ok = await service.propose({ moduleId, key: "add_note" }, { text: "ok" }, agent());
    const bad = await service.propose({ moduleId, key: "add_note" }, { text: "bad" }, agent());
    const okJob = (await service.approve(ok.id, person("boss@example.test"))).jobId;
    const badJob = (await service.approve(bad.id, person("boss@example.test"))).jobId;
    assert.equal(await service.settle(), 0, "nothing finished yet");
    await pool!.query("update core.jobs set status = 'succeeded', finished_at = now() where id = $1", [okJob]);
    await pool!.query("update core.jobs set status = 'dead', finished_at = now(), last_error = $2 where id = $1", [badJob, "boom ".repeat(200)]);
    assert.equal(await service.settle(), 2);
    assert.equal(await service.settle(), 0);
    const executed = await service.get(ok.id);
    const failed = await service.get(bad.id);
    assert.equal(executed?.outcome, "executed");
    assert.equal(failed?.outcome, "failed");
    assert.ok((failed?.lastError ?? "").length <= 500, "the error is cut");
    const types = (await events()).map((event) => event.type);
    assert.equal(types.filter((type) => type === "core.action.executed").length, 1);
    assert.equal(types.filter((type) => type === "core.action.failed").length, 1);
  });

  test("lists the newest first, by status, with the job's state", async () => {
    const a = await service.propose({ moduleId, key: "add_note" }, { text: "a" }, agent());
    const b = await service.propose({ moduleId, key: "close_deal" }, {}, agent());
    await service.reject(a.id, person("boss@example.test"));
    assert.deepEqual((await service.list({})).map((row) => row.id), [b.id, a.id]);
    assert.deepEqual((await service.list({ status: "pending" })).map((row) => row.id), [b.id]);
    assert.equal((await service.list({ limit: 1 })).length, 1);
  });
});

describe("the actions command", () => {
  const out = (): { lines: string[]; io: { out: (line: string) => void; err: (line: string) => void } } => {
    const lines: string[] = [];
    return { lines, io: { out: (line) => lines.push(line), err: (line) => lines.push(line) } };
  };
  const command = (over: Partial<ActionsCommand>): ActionsCommand => ({ action: "list", args: [], input: undefined, status: undefined, note: undefined, actor: "cli", via: "cli", json: false, ...over });
  const go = async (over: Partial<ActionsCommand>) => {
    const sink = out();
    await runActionsCommand(command(over), { pool: pool!, registry: box.registry(), io: sink.io, service });
    return sink.lines;
  };

  test("lists what the modules offer as a table, and as JSON with the inputs but without the module's statement or job", async () => {
    const table = (await go({})).join("\n");
    assert.match(table, /ACTION\s+RISK\s+PERMISSION/);
    assert.match(table, new RegExp(`${moduleId}\\.add_note\\s+write\\s+acts\\.write`));
    const json = JSON.parse((await go({ json: true })).join("\n")) as { ref: string; input: Record<string, unknown>; sql?: string; job?: string }[];
    const note = json.find((entry) => entry.ref === `${moduleId}.add_note`);
    assert.deepEqual(Object.keys(note?.input ?? {}), ["text"]);
    assert.equal(json.some((entry) => "sql" in entry || "job" in entry), false);
  });

  test("runs a read for the rows as JSON, and a write as the person that ran it", async () => {
    await seedNotes();
    assert.deepEqual(JSON.parse((await go({ action: "run", args: [`${moduleId}.find_notes`], input: { text: "email" } }))[0]!).map((row: { body: string }) => row.body), ["email Bob"]);
    const [line] = await go({ action: "run", args: [`${moduleId}.add_note`], input: { text: "from the cli" }, actor: "ada@example.test" });
    assert.match(line!, /queued job \d+ \(proposal \d+, approved by ada@example.test\)/);
  });

  test("lets an agent's channel propose and read, and a person decide, and nobody else", async () => {
    const [proposed] = await go({ action: "propose", args: [`${moduleId}.add_note`], input: { text: "ask first" }, actor: "agent:mcp", via: "mcp" });
    assert.match(proposed!, /proposal \d+ is waiting for a person/);
    const id = Number(/proposal (\d+)/.exec(proposed!)![1]);
    assert.match((await go({ action: "proposals", status: "pending" })).join("\n"), new RegExp(`${id}\\s+pending\\s+${moduleId}\\.add_note\\s+write\\s+agent:mcp`));
    await assert.rejects(go({ action: "approve", args: [String(id)], actor: "agent:mcp", via: "mcp" }), (error: unknown) => error instanceof ActionError && error.code === "forbidden");
    await assert.rejects(go({ action: "run", args: [`${moduleId}.add_note`], input: { text: "x" }, actor: "agent:mcp", via: "mcp" }), (error: unknown) => error instanceof ActionError && error.code === "needs_approval");
    assert.match((await go({ action: "approve", args: [String(id)], actor: "boss@example.test" }))[0]!, new RegExp(`proposal ${id} approved: job \\d+ queued`));
    assert.equal((await jobs()).length, 1);
  });

  test("shows the input of a proposal only in the JSON form, and rejects with a note", async () => {
    const proposal = await service.propose({ moduleId, key: "add_note" }, { text: "PRIVATE-WORDS" }, agent());
    assert.doesNotMatch((await go({ action: "proposals" })).join("\n"), /PRIVATE-WORDS/);
    assert.match((await go({ action: "proposals", json: true })).join("\n"), /PRIVATE-WORDS/);
    assert.equal((await go({ action: "reject", args: [String(proposal.id)], note: "no thanks", actor: "boss@example.test" }))[0], `proposal ${proposal.id} rejected`);
    assert.equal((await service.get(proposal.id))?.decisionNote, "no thanks");
  });

  test("refuses a reference that is not <module>.<key> and an id that is not a number", async () => {
    await assert.rejects(go({ action: "run", args: ["nodots"] }), /<module>\.<key>/);
    await assert.rejects(go({ action: "approve", args: ["abc"] }), /not a proposal id/);
    await assert.rejects(go({ action: "approve", args: [] }), /not a proposal id/);
  });

  test("answers a bad command line as a usage error before it touches the database", async () => {
    const run = async (argv: string[]) => {
      const sink = out();
      const code = await runCli(argv, sink.io as unknown as CliIo);
      return { code, text: sink.lines.join("\n") };
    };
    for (const [argv, message] of [
      [["actions"], /no actions command given/],
      [["actions", "nope"], /unknown actions command "nope"/],
      [["actions", "run", "m.k", "--via", "robot"], /--via must be cli or mcp/],
      [["actions", "run", "m.k", "--input", "{nope"], /--input must be a JSON object/],
      [["actions", "proposals", "--status", "maybe"], /--status must be pending, approved, rejected or expired/],
    ] as const) {
      const result = await run([...argv]);
      assert.equal(result.code, 2, argv.join(" "));
      assert.match(result.text, message);
    }
  });
});
