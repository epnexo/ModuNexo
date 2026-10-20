import type pg from "pg";

/**
 * The part of the platform singleton that the server entry needs on shutdown. It lives apart from `platform()`
 * because `scripts/serve.ts` is run by Node's own TypeScript support, which only strips types: it cannot load the
 * core's services (they use parameter properties). Keep this file to syntax Node can strip and to type-only imports.
 */
export const STORE = Symbol.for("modunexo.web.platform");
export const CLOSED = Symbol.for("modunexo.web.platform.closed");
export const HUB = Symbol.for("modunexo.web.events.hub");

export interface PlatformHolder {
  [STORE]?: { pool: pg.Pool };
  [CLOSED]?: true;
  /** The event hub of this process, once a stream asked for it. It listens on its own connection, so it stops first. */
  [HUB]?: { ready: Promise<{ stop(): Promise<void> }> };
}

export const holder = (): PlatformHolder => globalThis as unknown as PlatformHolder;

/** Allows `platform()` again after `closePlatform()`. Only tests need it: a server that stopped does not restart. */
export function reopenPlatform(): void {
  delete holder()[CLOSED];
}

/** Ends the pool, if one was created. Called once, when the server is stopping. */
export async function closePlatform(): Promise<void> {
  const current = holder();
  current[CLOSED] = true;
  const hub = current[HUB];
  delete current[HUB];
  await hub?.ready.then((started) => started.stop()).catch(() => undefined);
  const platform = current[STORE];
  if (platform === undefined) return;
  delete current[STORE];
  await platform.pool.end();
}
