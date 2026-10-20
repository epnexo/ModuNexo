import { EventHub, EventService } from "@modunexo/core/events";
import { log } from "@modunexo/core/log";
import { HUB, holder } from "./platform-lifecycle.ts";
import { platform } from "./platform.ts";
import { webRegistry } from "./registry.ts";

/**
 * The one hub of this process, started by the first stream that needs it and stopped with the platform. A hub that
 * could not start is forgotten, so the next stream tries again.
 */
export function eventHub(): Promise<EventHub> {
  const state = holder();
  if (state[HUB] === undefined) {
    const { pool } = platform();
    const hub = new EventHub(pool, new EventService(pool, webRegistry()), { log });
    const ready = hub.start().then(() => hub);
    state[HUB] = { ready };
    ready.catch(() => {
      if (state[HUB]?.ready === ready) delete state[HUB];
    });
  }
  return state[HUB].ready as Promise<EventHub>;
}
