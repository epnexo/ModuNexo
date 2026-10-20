import type pg from "pg";
import { eventType, type PublishOptions, type PublishResult } from "@modunexo/sdk";
import type { Executor } from "../executor.ts";
import { JobError } from "../jobs/errors.ts";
import { JobService } from "../jobs/service.ts";
import type { Registry } from "../registry.ts";
import { EventError } from "./errors.ts";

/** The channel an event's position is announced on, after the transaction that wrote it commits. */
export const EVENTS_CHANNEL = "modunexo_events";
export const MAX_EVENT_PAYLOAD_BYTES = 16 * 1024;
export const EVENT_RETENTION_DAYS = 7;
export const MAX_EVENT_TYPE_CHARS = 200;
/** Taken before an id is assigned and held to the end of the transaction, so ids become visible in order. */
const PUBLISH_LOCK = 7_251_041;
const MAX_LIST = 500;
/** JSON text of a string holding a NUL character: a `\u0000` escape not itself escaped by a backslash. */
const NUL_ESCAPE = /(?<!\\)(?:\\\\)*\\u0000/;
/** JSON.stringify writes a surrogate as an escape only when it is unpaired, and jsonb refuses those. */
const LONE_SURROGATE = /(?<!\\)(?:\\\\)*\\ud[89a-f][0-9a-f]{2}/i;

/** An event as readers see it. */
export interface EventRecord {
  id: number;
  moduleId: string;
  type: string;
  payload?: unknown;
  createdAt: Date;
}

export interface EventListOptions {
  moduleId?: string;
  type?: string;
  limit?: number;
  withPayload?: boolean;
}

/** Where a stream that remembers position `after` can resume. `reset` means events were lost in between. */
export interface CursorResolution {
  reset: boolean;
  from: number;
}

export interface EventServiceOptions {
  now?: () => Date;
}

const toRecord = (row: Record<string, unknown>): EventRecord => ({
  id: Number(row.id),
  moduleId: row.module_id as string,
  type: row.type as string,
  ...("payload" in row ? { payload: row.payload } : {}),
  createdAt: row.created_at as Date,
});

/** The event log: publish (with fan-out to subscribed jobs), read after a position, list, prune. */
export class EventService {
  private readonly now: () => Date;

  constructor(
    private readonly pool: pg.Pool,
    private readonly registry: Registry,
    options: EventServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Publish an event the module declared. With `options.tx` the rows go into the caller's transaction, so they exist
   * only if it commits and the announcement on the channel is delivered by the database at that commit; without it,
   * the event has a transaction of its own. Every enabled module subscribed to the type gets its job queued in the same
   * transaction.
   */
  async publish(moduleId: string, name: string, payload: unknown, options: PublishOptions = {}): Promise<PublishResult> {
    const manifest = this.registry.get(moduleId);
    if (manifest === undefined) throw new EventError(`module "${moduleId}" is not registered`);
    const declared = manifest.events ?? [];
    if (!declared.some((candidate) => candidate.name === name)) {
      const names = declared.map((candidate) => candidate.name).sort();
      throw new EventError(`module "${moduleId}" does not declare the event "${name}"${names.length === 0 ? " (it declares none)" : ` (declared: ${names.join(", ")})`}`);
    }
    const json = this.serialise(payload);
    const type = eventType(moduleId, name);
    // Checked here because Postgres would refuse it inside the caller's transaction and leave that transaction aborted.
    if (type.length > MAX_EVENT_TYPE_CHARS) throw new EventError(`the event type "${type.slice(0, 40)}…" is over ${MAX_EVENT_TYPE_CHARS} characters`);

    if (options.tx !== undefined) return this.write(options.tx as Executor, moduleId, type, json);
    const client = await this.pool.connect();
    let broken = false;
    try {
      await client.query("begin");
      const result = await this.write(client, moduleId, type, json);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => {
        broken = true;
      });
      throw error;
    } finally {
      client.release(broken ? true : undefined);
    }
  }

  private serialise(payload: unknown): string {
    let json: string;
    try {
      json = JSON.stringify(payload === undefined ? null : payload) ?? "null";
    } catch {
      throw new EventError("the payload must be JSON: it cannot be serialised");
    }
    if (Buffer.byteLength(json) > MAX_EVENT_PAYLOAD_BYTES) throw new EventError(`the payload is over ${MAX_EVENT_PAYLOAD_BYTES / 1024} KiB`);
    // Checked here because Postgres would refuse it inside the caller's transaction and leave that transaction aborted.
    if (NUL_ESCAPE.test(json)) throw new EventError("the payload cannot be stored: a string in it holds the character \\u0000");
    if (LONE_SURROGATE.test(json)) throw new EventError("the payload cannot be stored: a string in it holds an unpaired surrogate");
    return json;
  }

  private async write(db: Executor, moduleId: string, type: string, json: string): Promise<PublishResult> {
    const enabled = await db.query("select 1 from core.modules where id = $1 and state = 'enabled'", [moduleId]);
    if (enabled.rowCount === 0) throw new EventError(`module "${moduleId}" is not enabled`);
    await db.query("select pg_advisory_xact_lock($1)", [PUBLISH_LOCK]);
    const createdAt = this.now();
    const inserted = await db.query("insert into core.events (module_id, type, payload, created_at) values ($1, $2, $3::jsonb, $4) returning id", [moduleId, type, json, createdAt]);
    const id = Number(inserted.rows[0]!.id);

    const subscriptions = this.registry
      .all()
      .flatMap((manifest) => (manifest.subscriptions ?? []).filter((s) => s.event === type).map((s) => ({ moduleId: manifest.id, job: s.job })));
    if (subscriptions.length > 0) {
      const live = await db.query("select id from core.modules where state = 'enabled' and id = any($1::text[])", [[...new Set(subscriptions.map((s) => s.moduleId))]]);
      const enabledIds = new Set(live.rows.map((row) => row.id as string));
      const jobs = new JobService(this.pool, this.registry, { now: this.now });
      const message = { event: { id, type, payload: JSON.parse(json) as unknown, createdAt: createdAt.toISOString() } };
      for (const subscription of subscriptions) {
        if (!enabledIds.has(subscription.moduleId)) continue;
        try {
          await jobs.enqueue(subscription.moduleId, subscription.job, message, {}, `event:${moduleId}`, db);
        } catch (error) {
          // A subscriber the platform refuses (a job it no longer declares) must not stop the publisher's own transaction.
          // JobError is raised before any statement that could abort it.
          if (!(error instanceof JobError)) throw error;
        }
      }
    }
    await db.query("select pg_notify($1, $2)", [EVENTS_CHANNEL, String(id)]);
    return { id };
  }

  /** Events with a position above `after`, oldest first. `types` null means every type; an empty list means none. */
  async readAfter(after: number, types: string[] | null, limit: number): Promise<EventRecord[]> {
    if (types !== null && types.length === 0) return [];
    const result = await this.pool.query(
      `select id, module_id, type, payload, created_at from core.events
       where id > $1 and ($2::text[] is null or type = any($2::text[]))
       order by id limit $3`,
      [after, types, Math.min(Math.max(1, limit), MAX_LIST)],
    );
    return result.rows.map(toRecord);
  }

  /**
   * Where a stream whose client last saw position `after` may continue. A cursor of 0 starts from the beginning. A cursor
   * ahead of everything ever assigned (a restored database) or behind the oldest row kept (events were pruned) means
   * the client missed events: `reset` is true and `from` is the position to continue from.
   */
  async resolveCursor(after: number): Promise<CursorResolution> {
    if (!(after > 0)) return { reset: false, from: 0 };
    const [oldest, last] = await Promise.all([this.pool.query("select min(id) as id from core.events"), this.lastAssigned()]);
    if (after > last) return { reset: true, from: last };
    const first = oldest.rows[0].id === null ? null : Number(oldest.rows[0].id);
    if (first === null) return after < last ? { reset: true, from: last } : { reset: false, from: after };
    if (after < first - 1) return { reset: true, from: first - 1 };
    return { reset: false, from: after };
  }

  /** The highest position ever assigned, 0 when none was. It may belong to a publisher that has not committed yet. */
  async lastAssigned(): Promise<number> {
    const assigned = await this.pool.query("select last_value, is_called from core.events_id_seq");
    return assigned.rows[0]!.is_called ? Number(assigned.rows[0]!.last_value) : 0;
  }

  /**
   * The highest position, once every publisher that was in the middle of a commit has finished: it takes the lock
   * publishers hold, so the position it returns is visible to readers and nothing below it is still to come.
   */
  async settledPosition(): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock($1)", [PUBLISH_LOCK]);
      const assigned = await client.query("select last_value, is_called from core.events_id_seq");
      await client.query("commit");
      return assigned.rows[0]!.is_called ? Number(assigned.rows[0]!.last_value) : 0;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** The newest events, newest first. A payload is returned only when asked for. */
  async list(options: EventListOptions): Promise<EventRecord[]> {
    const columns = options.withPayload === true ? "id, module_id, type, payload, created_at" : "id, module_id, type, created_at";
    const result = await this.pool.query(
      `select ${columns} from core.events
       where ($1::text is null or module_id = $1) and ($2::text is null or type = $2)
       order by id desc limit $3`,
      [options.moduleId ?? null, options.type ?? null, Math.min(Math.max(1, options.limit ?? 50), MAX_LIST)],
    );
    return result.rows.map(toRecord);
  }

  /** Deletes events older than the retention period. Returns how many. */
  async prune(): Promise<number> {
    const cutoff = new Date(this.now().getTime() - EVENT_RETENTION_DAYS * 86_400_000);
    const deleted = await this.pool.query("delete from core.events where created_at < $1", [cutoff]);
    return deleted.rowCount ?? 0;
  }
}
