import pg from "pg";
import { log as platformLog } from "../log.ts";
import { EVENTS_CHANNEL, type EventRecord, type EventService } from "./service.ts";

export interface HubLog {
  info: (event: string, fields?: Record<string, unknown>) => void;
  warn: (event: string, fields?: Record<string, unknown>) => void;
  error: (event: string, fields?: Record<string, unknown>) => void;
}

export interface EventHubOptions {
  /** How often the log is read even if no announcement came, so a lost one only delays an event. Default 5 s. */
  pollMs?: number;
  /** First wait before listening again after the connection was lost; it doubles up to 30 s. Default 1 s. */
  reconnectMs?: number;
  log?: HubLog;
  /** The connection that listens. Default: a client with the pool's own settings. */
  createClient?: () => pg.Client;
}

const BATCH = 200;
const MAX_RECONNECT_MS = 30_000;

/**
 * One per process. It listens for the database's announcement that an event was committed (from any process: the web
 * app, the worker, the CLI), reads the log from the last position it handed out, and gives each new event to the
 * subscribers, in order. Nothing depends on the announcement alone: it also reads on a timer and after every
 * reconnect, so an announcement that never arrived delays an event but cannot lose it.
 */
export class EventHub {
  private readonly pollMs: number;
  private readonly reconnectMs: number;
  private readonly log: HubLog;
  private readonly createClient: () => pg.Client;
  private readonly listeners = new Set<(event: EventRecord) => void>();
  private client: pg.Client | undefined;
  private poll: NodeJS.Timeout | undefined;
  private retry: NodeJS.Timeout | undefined;
  private position = 0;
  private pumping = false;
  private again = false;
  private stopped = true;
  private wait: number;

  constructor(
    private readonly pool: pg.Pool,
    private readonly events: EventService,
    options: EventHubOptions = {},
  ) {
    this.pollMs = options.pollMs ?? 5000;
    this.reconnectMs = options.reconnectMs ?? 1000;
    this.wait = this.reconnectMs;
    this.log = options.log ?? platformLog;
    this.createClient = options.createClient ?? (() => new pg.Client({ ...this.pool.options, keepAlive: true }));
  }

  /** Subscribers now. */
  get size(): number {
    return this.listeners.size;
  }

  /** Starts from the newest committed event: what came before is for a client to ask for with its cursor. */
  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    try {
      this.position = await this.events.settledPosition();
    } catch (error) {
      this.stopped = true;
      throw error;
    }
    // Stopped while the position was being read: start nothing.
    if (this.stopped) return;
    this.poll = setInterval(() => void this.pump(), this.pollMs);
    this.poll.unref();
    await this.listen();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.poll);
    clearTimeout(this.retry);
    this.poll = undefined;
    this.retry = undefined;
    this.listeners.clear();
    const client = this.client;
    this.client = undefined;
    await client?.end().catch(() => undefined);
  }

  /** Calls `listener` with every event from now on. Returns the way to stop. */
  subscribe(listener: (event: EventRecord) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private async listen(): Promise<void> {
    if (this.stopped) return;
    let client: pg.Client | undefined;
    try {
      client = this.createClient();
      const lost = () => this.lost(client!);
      client.on("error", lost);
      client.on("end", lost);
      client.on("notification", () => void this.pump());
      await client.connect();
      await client.query(`listen ${EVENTS_CHANNEL}`);
      if (this.stopped) {
        await client.end().catch(() => undefined);
        return;
      }
      this.client = client;
      this.wait = this.reconnectMs;
      // Whatever was committed while there was no connection.
      void this.pump();
    } catch (error) {
      await client?.end().catch(() => undefined);
      this.log.warn("events.hub_listen_failed", { error });
      this.scheduleRetry();
    }
  }

  private lost(client: pg.Client): void {
    if (this.client !== client || this.stopped) return;
    this.client = undefined;
    client.end().catch(() => undefined);
    this.log.warn("events.hub_connection_lost");
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retry !== undefined) return;
    const wait = this.wait;
    this.wait = Math.min(this.wait * 2, MAX_RECONNECT_MS);
    this.retry = setTimeout(() => {
      this.retry = undefined;
      void this.listen();
    }, wait);
    this.retry.unref();
  }

  /** Reads what is new and hands it out. One read at a time; a request that arrives meanwhile makes it read once more. */
  private async pump(): Promise<void> {
    if (this.stopped) return;
    if (this.pumping) {
      this.again = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.again = false;
        for (;;) {
          const batch = await this.events.readAfter(this.position, null, BATCH);
          for (const event of batch) {
            if (this.stopped) return;
            this.position = event.id;
            this.deliver(event);
          }
          if (batch.length < BATCH) break;
        }
      } while (this.again && !this.stopped);
    } catch (error) {
      this.log.warn("events.hub_read_failed", { error });
    } finally {
      this.pumping = false;
    }
  }

  private deliver(event: EventRecord): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.log.warn("events.hub_subscriber_failed", { error });
      }
    }
  }
}
