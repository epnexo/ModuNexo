import type { EventRecord, EventService } from "@modunexo/core/events";
import type { ModuleManifest } from "@modunexo/sdk";
import { type Subject, subjectCan } from "./nav.ts";

/** An event type a browser may be sent: the module that publishes it and the permission that opens it. */
export interface StreamableEvent {
  moduleId: string;
  permission: string;
}

export const MAX_TYPES = 20;
export const MAX_STREAMS = 200;

/** Every event the manifests tie to a permission, by full type. An event without a permission is never streamed. */
export function streamableEvents(manifests: readonly ModuleManifest[]): Map<string, StreamableEvent> {
  const catalogue = new Map<string, StreamableEvent>();
  for (const manifest of manifests) {
    for (const event of manifest.events ?? []) {
      if (event.permission !== undefined) catalogue.set(`${manifest.id}.${event.name}`, { moduleId: manifest.id, permission: event.permission });
    }
  }
  return catalogue;
}

export type TypeSelection = { ok: true; types: Set<string> } | { ok: false; status: 400 | 403; error: string };

/**
 * The types a stream will carry: those asked for in `types=a,b` (default: all the viewer may follow). A type that is not
 * streamed at all is a bad request; a viewer who holds no permission to follow anything is refused.
 */
export function selectEventTypes(catalogue: ReadonlyMap<string, StreamableEvent>, subject: Subject, asked: string | null): TypeSelection {
  const permitted = new Set([...catalogue].filter(([, event]) => subjectCan(subject, event.permission)).map(([type]) => type));
  if (permitted.size === 0) return { ok: false, status: 403, error: "you do not have permission to follow any event" };
  if (asked === null || asked.trim() === "") return { ok: true, types: permitted };
  const names = asked.split(",").map((name) => name.trim());
  if (names.length > MAX_TYPES) return { ok: false, status: 400, error: `ask for at most ${MAX_TYPES} types` };
  const types = new Set<string>();
  for (const name of names) {
    if (name === "" || !catalogue.has(name)) return { ok: false, status: 400, error: `"${name}" is not an event type that can be followed` };
    if (!permitted.has(name)) return { ok: false, status: 403, error: `you do not have permission to follow "${name}"` };
    types.add(name);
  }
  return { ok: true, types };
}

export interface StreamDeps {
  hub: { subscribe(listener: (event: EventRecord) => void): () => void };
  events: Pick<EventService, "resolveCursor" | "readAfter" | "lastAssigned">;
  /** The modules that are enabled now: an event of any other is not sent. */
  enabledModules: () => Promise<ReadonlySet<string>>;
  /** A comment line this often keeps proxies from closing a quiet connection. Default 20 s. */
  heartbeatMs?: number;
  /** A backlog larger than this is not replayed: the client is told to start over. Default 1000. */
  replayLimit?: number;
  /** A client this many frames behind is disconnected; it resumes by its cursor. Default 500. */
  maxQueued?: number;
  log: { warn: (event: string, fields?: Record<string, unknown>) => void };
}

export interface StreamRequest {
  types: ReadonlySet<string>;
  /** The position the client last saw; 0 for none. */
  after: number;
  signal: AbortSignal;
  /** Called once, whichever way the stream ends. */
  onClose?: () => void;
}

const encoder = new TextEncoder();
const RETRY_MS = 3000;

const dataFrame = (event: EventRecord): string =>
  `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify({ id: event.id, type: event.type, payload: event.payload ?? null, createdAt: event.createdAt.toISOString() })}\n\n`;
const resetFrame = (from: number): string => `id: ${from}\nevent: reset\ndata: ${JSON.stringify({ after: from })}\n\n`;

/**
 * The body of a server-sent-events response: the events after `after` that the client missed, then new ones as the hub
 * hands them out, each once and in order. It subscribes to the hub before it reads the log, so nothing falls between
 * the two; an event seen by both is sent once. A stream that cannot be kept up with, or whose log cannot be read, is
 * ended, and the client resumes with the cursor of the last frame it got.
 */
export function openEventStream(deps: StreamDeps, request: StreamRequest): ReadableStream<Uint8Array> {
  const { types, after, signal } = request;
  const replayLimit = deps.replayLimit ?? 1000;
  const heartbeatMs = deps.heartbeatMs ?? 20_000;
  const maxQueued = deps.maxQueued ?? 500;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let unsubscribe = () => {};
  let heartbeat: NodeJS.Timeout | undefined;
  let closed = false;
  let sent = after;
  let chain: Promise<void> = Promise.resolve();

  const onAbort = () => close();
  function close(error?: unknown): void {
    if (closed) return;
    closed = true;
    unsubscribe();
    clearInterval(heartbeat);
    signal.removeEventListener("abort", onAbort);
    try {
      if (error === undefined) controller.close();
      else controller.error(error);
    } catch {
      // The client already cancelled: nothing is left to close.
    }
    request.onClose?.();
  }
  function send(text: string): void {
    if (closed) return;
    controller.enqueue(encoder.encode(text));
    if (controller.desiredSize !== null && controller.desiredSize <= -maxQueued) close();
  }
  async function deliver(event: EventRecord): Promise<void> {
    if (closed || event.id <= sent || !types.has(event.type)) return;
    const live = await deps.enabledModules();
    if (closed || event.id <= sent || !live.has(event.moduleId)) return;
    send(dataFrame(event));
    sent = event.id;
  }
  async function replay(): Promise<void> {
    const resolved = await deps.events.resolveCursor(after);
    sent = resolved.from;
    if (resolved.reset) send(resetFrame(resolved.from));
    const batch = await deps.events.readAfter(sent, [...types], replayLimit + 1);
    if (batch.length > replayLimit) {
      sent = await deps.events.lastAssigned();
      send(resetFrame(sent));
      return;
    }
    for (const event of batch) await deliver(event);
  }
  const fail = (error: unknown) => {
    deps.log.warn("events.stream_failed", { error });
    close(error);
  };

  return new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      send(`retry: ${RETRY_MS}\n\n`);
      if (signal.aborted) return close();
      signal.addEventListener("abort", onAbort, { once: true });
      heartbeat = setInterval(() => send(": keepalive\n\n"), heartbeatMs);
      heartbeat.unref();
      // The replay is the first link of the chain and the hub's events queue behind it, so order is kept.
      chain = replay().catch(fail);
      unsubscribe = deps.hub.subscribe((event) => {
        chain = chain.then(() => deliver(event)).catch(fail);
      });
    },
    cancel() {
      close();
    },
  });
}
