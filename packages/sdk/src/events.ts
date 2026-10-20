import type { DbQueryable } from "./db.ts";

/**
 * How a module's code announces that something happened. An event is a typed fact the module registered in its manifest:
 * other modules that subscribe get a job run for it, and a signed-in browser can follow it live. Like jobs, the publisher
 * is reached through a global symbol that the platform registers (the web app and the worker do), so the SDK stays free
 * of database code and every copy of it finds the same one.
 */
export const EVENTS_PUBLISHER: unique symbol = Symbol.for("modunexo.events.publisher") as never;

export interface PublishOptions {
  /**
   * The handle `getDb(moduleId).transaction` gives. With it the event is written in that transaction: it exists exactly
   * when the caller's data does, and nothing is announced before commit. Without it the event has its own transaction.
   */
  tx?: DbQueryable;
}

export interface PublishResult {
  /** The event's position in the log; a browser resumes after it. */
  id: number;
}

export interface EventsPublisher {
  publish(moduleId: string, name: string, payload: unknown, options: PublishOptions): Promise<PublishResult>;
}

/** `publishEvent` ran where the platform has not registered a publisher: a script, a test, a build step. */
export class EventsUnavailableError extends Error {
  constructor() {
    super("events can only be published while the platform is running: no events publisher is registered in this process");
    this.name = "EventsUnavailableError";
  }
}

/** The full type of an event: the module that publishes it, a dot, and the name it declared. */
export const eventType = (moduleId: string, name: string): string => `${moduleId}.${name}`;

/**
 * Publish an event the module declared. The module must be enabled; the payload must be JSON and at most 16 KiB.
 * Rejects with the platform's reason when it refuses.
 */
export async function publishEvent(moduleId: string, name: string, payload?: unknown, options: PublishOptions = {}): Promise<PublishResult> {
  const publisher = (globalThis as typeof globalThis & { [EVENTS_PUBLISHER]?: EventsPublisher })[EVENTS_PUBLISHER];
  if (publisher === undefined) throw new EventsUnavailableError();
  return publisher.publish(moduleId, name, payload ?? null, options);
}
