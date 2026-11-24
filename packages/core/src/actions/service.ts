import type pg from "pg";
import type { ActionDeclaration } from "@modunexo/sdk";
import { CORE_MODULE_ID } from "../core-module.ts";
import { ModuleDbService } from "../data/module-db.ts";
import type { ModuleRoles } from "../data/module-roles.ts";
import { JobService } from "../jobs/service.ts";
import { log as platformLog } from "../log.ts";
import type { Registry } from "../registry.ts";
import { checkActionInput } from "./input.ts";

export type ActionErrorCode =
  | "unknown_action"
  | "disabled"
  | "forbidden"
  | "invalid_input"
  | "not_proposable"
  | "needs_approval"
  | "too_many_pending"
  | "not_pending"
  | "self_approval"
  | "failed";

/** What went wrong in words that are safe to show to whoever asked: never a driver message, never an input. */
export class ActionError extends Error {
  constructor(
    readonly code: ActionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ActionError";
  }
}

/** Who is asking: a name for the register, the channel it came through, and what they may do. An agent's `can` is always false for a module permission. */
export interface Actor {
  name: string;
  via: "mcp" | "portal" | "cli";
  can: (permission: string) => boolean;
}

export interface ActionRef {
  moduleId: string;
  key: string;
}

export interface CatalogEntry {
  moduleId: string;
  moduleName: string;
  key: string;
  /** `<module id>.<action key>`, the name an agent and the portal use. */
  ref: string;
  action: ActionDeclaration;
}

export type ProposalStatus = "pending" | "approved" | "rejected" | "expired";

export interface Proposal {
  id: number;
  moduleId: string;
  actionKey: string;
  risk: "write" | "sensitive";
  status: ProposalStatus;
  input: Record<string, unknown>;
  proposedBy: string;
  proposedVia: "mcp" | "portal" | "cli";
  proposedAt: Date;
  expiresAt: Date;
  decidedBy: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  jobId: number | null;
  /** Set once the approved action's job finished (see `settle`). */
  outcome: "executed" | "failed" | null;
  lastError: string | null;
  /** The state of the job now, for an approved action: queued, running, succeeded, dead or cancelled. */
  jobStatus: string | null;
}

export type RunResult = { kind: "rows"; rows: Record<string, unknown>[] } | { kind: "queued"; proposalId: number; jobId: number };

export interface ActionServiceOptions {
  now?: () => Date;
  /** The module logins; without them a read action runs on the platform's legacy read role (tests only). */
  moduleRoles?: ModuleRoles;
  /** How long an unapproved proposal waits. Seven days. */
  ttlMs?: number;
  /** How many proposals may wait at once, across all agents. */
  maxPending?: number;
  /** A read action's statement is cut off after this long. */
  statementTimeoutMs?: number;
}

const DAY_MS = 86_400_000;
const MAX_ROWS = 100;
const MAX_ERROR_CHARS = 500;
const DEFAULT_MAX_PENDING = 100;

type Executor = Pick<pg.PoolClient, "query">;

interface Row {
  id: string;
  module_id: string;
  action_key: string;
  risk: "write" | "sensitive";
  status: ProposalStatus;
  input: Record<string, unknown>;
  proposed_by: string;
  proposed_via: "mcp" | "portal" | "cli";
  proposed_at: Date;
  expires_at: Date;
  decided_by: string | null;
  decided_at: Date | null;
  decision_note: string | null;
  job_id: string | null;
  outcome: "executed" | "failed" | null;
  last_error: string | null;
  job_status: string | null;
}

const SELECT = `select p.*, j.status as job_status from core.action_proposals p left join core.jobs j on j.id = p.job_id`;

const toProposal = (row: Row): Proposal => ({
  id: Number(row.id),
  moduleId: row.module_id,
  actionKey: row.action_key,
  risk: row.risk,
  status: row.status,
  input: row.input,
  proposedBy: row.proposed_by,
  proposedVia: row.proposed_via,
  proposedAt: row.proposed_at,
  expiresAt: row.expires_at,
  decidedBy: row.decided_by,
  decidedAt: row.decided_at,
  decisionNote: row.decision_note,
  jobId: row.job_id === null ? null : Number(row.job_id),
  outcome: row.outcome,
  lastError: row.last_error,
  jobStatus: row.job_status,
});

/**
 * What an agent or a person may ask the modules to do (the `actions` a manifest declares), and the register of what they did.
 * A `read` action runs at once as the module's own read-only statement. A `write` or `sensitive` action run by a person is that
 * person's decision, so it queues the module's job at once and is recorded already approved; asked by an agent it becomes a pending
 * proposal that a person holding the action's permission approves or rejects, and that expires if nobody does. Approving is the only
 * way an agent's request runs, and no agent can approve. The events published for each step carry who and what, never the input.
 */
export class ActionService {
  readonly #db: ModuleDbService;
  readonly #jobs: JobService;
  readonly #now: () => Date;
  readonly #ttlMs: number;
  readonly #maxPending: number;

  constructor(
    private readonly pool: pg.Pool,
    private readonly registry: Registry,
    options: ActionServiceOptions = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#ttlMs = options.ttlMs ?? 7 * DAY_MS;
    this.#maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
    this.#db = new ModuleDbService(pool, registry, { statementTimeoutMs: options.statementTimeoutMs ?? 5_000, ...(options.moduleRoles === undefined ? {} : { moduleRoles: options.moduleRoles }) });
    this.#jobs = new JobService(pool, registry, { now: this.#now });
  }

  async #enabledIds(): Promise<Set<string>> {
    const { rows } = await this.pool.query("select id from core.modules where state = 'enabled'");
    return new Set((rows as { id: string }[]).map((row) => row.id));
  }

  /** Every action of every enabled module, in module order and then in the order each module declared them. */
  async catalog(): Promise<CatalogEntry[]> {
    const enabled = await this.#enabledIds();
    return this.registry
      .all()
      .filter((manifest) => manifest.id !== CORE_MODULE_ID && enabled.has(manifest.id) && (manifest.actions ?? []).length > 0)
      .sort((a, b) => a.id.localeCompare(b.id))
      .flatMap((manifest) => (manifest.actions ?? []).map((action) => ({ moduleId: manifest.id, moduleName: manifest.name, key: action.key, ref: `${manifest.id}.${action.key}`, action })));
  }

  async #find(ref: ActionRef): Promise<ActionDeclaration> {
    const manifest = ref.moduleId === CORE_MODULE_ID ? undefined : this.registry.get(ref.moduleId);
    const action = manifest?.actions?.find((candidate) => candidate.key === ref.key);
    if (action === undefined) throw new ActionError("unknown_action", `there is no action "${ref.key}" in module "${ref.moduleId}"`);
    if (!(await this.#enabledIds()).has(ref.moduleId)) throw new ActionError("disabled", `module "${ref.moduleId}" is not enabled`);
    return action;
  }

  #event(executor: Executor, type: string, payload: Record<string, unknown>): Promise<unknown> {
    return executor.query("insert into core.events (module_id, type, payload, created_at) values ($1, $2, $3::jsonb, $4)", [CORE_MODULE_ID, `core.action.${type}`, JSON.stringify(payload), this.#now()]);
  }

  /** The facts of a step that anyone allowed to read events may see. The input is not among them, on purpose. */
  #facts(proposal: { id: number; module_id: string; action_key: string; risk: string; proposed_by: string }): Record<string, unknown> {
    return { id: proposal.id, module: proposal.module_id, action: proposal.action_key, risk: proposal.risk, proposedBy: proposal.proposed_by };
  }

  /**
   * Runs an action for a caller. A read returns its rows. A write or sensitive action asked by a person queues the module's job and
   * records the person as the decision; asked by an agent it is refused, because an agent proposes (see `propose`).
   */
  async run(ref: ActionRef, raw: unknown, actor: Actor): Promise<RunResult> {
    const action = await this.#find(ref);
    if (!actor.can(action.permission)) throw new ActionError("forbidden", `"${actor.name}" does not hold the permission this action needs`);
    const checked = checkActionInput(action, raw);
    if (!checked.ok) throw new ActionError("invalid_input", checked.message);

    if (action.risk === "read") {
      try {
        const result = await this.#db.readOwn(ref.moduleId).query(action.sql!, checked.ordered);
        return { kind: "rows", rows: result.rows.slice(0, MAX_ROWS) };
      } catch (error) {
        // The reason goes to the server's log, where only an operator reads it; the caller is told no more than "it failed".
        platformLog.warn("actions.read_failed", { module: ref.moduleId, action: ref.key, error });
        throw new ActionError("failed", "the action could not be run");
      }
    }
    if (actor.via === "mcp") throw new ActionError("needs_approval", `"${action.key}" changes data: an agent proposes it and a person approves it`);

    const now = this.#now();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const inserted = await client.query(
        `insert into core.action_proposals (module_id, action_key, risk, status, input, proposed_by, proposed_via, proposed_at, expires_at, decided_by, decided_at)
         values ($1, $2, $3, 'approved', $4::jsonb, $5, $6, $7, $7, $5, $7) returning *`,
        [ref.moduleId, ref.key, action.risk, JSON.stringify(checked.values), actor.name, actor.via, now],
      );
      const row = inserted.rows[0] as Row;
      const queued = await this.#jobs.enqueue(ref.moduleId, action.job!, checked.values, {}, `action:${row.id}`, client);
      await client.query("update core.action_proposals set job_id = $2 where id = $1", [row.id, queued.id]);
      await this.#event(client, "approved", { ...this.#facts({ ...row, id: Number(row.id) }), decidedBy: actor.name, via: actor.via, direct: true });
      await client.query("commit");
      return { kind: "queued", proposalId: Number(row.id), jobId: queued.id };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** An agent's request to change something: kept pending until a person decides, and gone after the time limit. */
  async propose(ref: ActionRef, raw: unknown, actor: Actor): Promise<Proposal> {
    const action = await this.#find(ref);
    if (action.risk === "read") throw new ActionError("not_proposable", `"${action.key}" only reads: run it, there is nothing to approve`);
    const checked = checkActionInput(action, raw);
    if (!checked.ok) throw new ActionError("invalid_input", checked.message);
    await this.expireDue();
    const pending = await this.pool.query("select count(*)::int as n from core.action_proposals where status = 'pending'");
    if ((pending.rows[0] as { n: number }).n >= this.#maxPending) throw new ActionError("too_many_pending", `there are already ${this.#maxPending} proposals waiting for a person`);

    const now = this.#now();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const inserted = await client.query(
        `insert into core.action_proposals (module_id, action_key, risk, input, proposed_by, proposed_via, proposed_at, expires_at)
         values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8) returning *`,
        [ref.moduleId, ref.key, action.risk, JSON.stringify(checked.values), actor.name, actor.via, now, new Date(now.getTime() + this.#ttlMs)],
      );
      const row = inserted.rows[0] as Row;
      await this.#event(client, "proposed", this.#facts({ ...row, id: Number(row.id) }));
      await client.query("commit");
      return toProposal({ ...row, job_status: null });
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Locks a pending proposal for a decision, after checking that the decider may take it. Returns the client holding the transaction. */
  async #lockPending(id: number, actor: Actor): Promise<{ client: pg.PoolClient; row: Row; action: ActionDeclaration }> {
    await this.expireDue();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const found = await client.query("select * from core.action_proposals where id = $1 for update", [id]);
      const row = found.rows[0] as Row | undefined;
      if (row === undefined || row.status !== "pending") throw new ActionError("not_pending", `proposal ${id} is not waiting for a decision`);
      const action = this.registry.get(row.module_id)?.actions?.find((candidate) => candidate.key === row.action_key);
      if (action === undefined) throw new ActionError("unknown_action", `module "${row.module_id}" no longer declares the action "${row.action_key}"`);
      if (!actor.can(action.permission)) throw new ActionError("forbidden", `"${actor.name}" does not hold the permission this action needs`);
      if (actor.name === row.proposed_by) throw new ActionError("self_approval", "whoever proposed an action cannot decide it");
      return { client, row, action };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      client.release();
      throw error;
    }
  }

  /** A person with the action's permission approves: the module's job is queued with the proposed input, once, in the same transaction. */
  async approve(id: number, actor: Actor): Promise<Proposal> {
    const { client, row, action } = await this.#lockPending(id, actor);
    try {
      const queued = await this.#jobs.enqueue(row.module_id, action.job!, row.input, {}, `action:${id}`, client);
      await client.query("update core.action_proposals set status = 'approved', decided_by = $2, decided_at = $3, job_id = $4 where id = $1", [id, actor.name, this.#now(), queued.id]);
      await this.#event(client, "approved", { ...this.#facts({ ...row, id }), decidedBy: actor.name, via: actor.via });
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return (await this.get(id))!;
  }

  /** A person with the action's permission says no. Nothing runs. */
  async reject(id: number, actor: Actor, note?: string): Promise<Proposal> {
    const { client, row } = await this.#lockPending(id, actor);
    try {
      await client.query("update core.action_proposals set status = 'rejected', decided_by = $2, decided_at = $3, decision_note = $4 where id = $1", [id, actor.name, this.#now(), note === undefined || note === "" ? null : note.slice(0, 300)]);
      await this.#event(client, "rejected", { ...this.#facts({ ...row, id }), decidedBy: actor.name });
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return (await this.get(id))!;
  }

  /** Marks the proposals nobody decided in time as expired, one event each. Returns how many. Safe to call any time, and more than once. */
  async expireDue(): Promise<number> {
    const { rows } = await this.pool.query(
      "update core.action_proposals set status = 'expired' where status = 'pending' and expires_at <= $1 returning id, module_id, action_key, risk, proposed_by",
      [this.#now()],
    );
    for (const row of rows as { id: string; module_id: string; action_key: string; risk: string; proposed_by: string }[]) {
      await this.#event(this.pool, "expired", this.#facts({ ...row, id: Number(row.id) }));
    }
    return rows.length;
  }

  /**
   * Records how the approved actions ended once their job finished: executed, or failed with the job's error (cut short). One event
   * each, and a settled action is never settled again. Returns how many were settled now.
   */
  async settle(): Promise<number> {
    const { rows } = await this.pool.query(
      `update core.action_proposals p
          set outcome = case j.status when 'succeeded' then 'executed' else 'failed' end,
              last_error = case when j.status = 'succeeded' then null else left(coalesce(j.last_error, j.status), ${MAX_ERROR_CHARS}) end,
              settled_at = $1
         from core.jobs j
        where j.id = p.job_id and p.status = 'approved' and p.outcome is null and j.status in ('succeeded', 'dead', 'cancelled')
        returning p.id, p.module_id, p.action_key, p.risk, p.proposed_by, p.outcome`,
      [this.#now()],
    );
    for (const row of rows as { id: string; module_id: string; action_key: string; risk: string; proposed_by: string; outcome: string }[]) {
      await this.#event(this.pool, row.outcome, this.#facts({ ...row, id: Number(row.id) }));
    }
    return rows.length;
  }

  async get(id: number): Promise<Proposal | null> {
    const { rows } = await this.pool.query(`${SELECT} where p.id = $1`, [id]);
    return rows[0] === undefined ? null : toProposal(rows[0] as Row);
  }

  /** The register, newest first. Settles and expires first, so what it shows is current. */
  async list(options: { status?: ProposalStatus; limit?: number }): Promise<Proposal[]> {
    await this.expireDue();
    await this.settle();
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const { rows } = await this.pool.query(`${SELECT} where ($1::text is null or p.status = $1) order by p.id desc limit $2`, [options.status ?? null, limit]);
    return (rows as Row[]).map(toProposal);
  }
}
