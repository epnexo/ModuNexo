export interface HealthReply {
  status: 200 | 503;
  body: { status: "ok"; database: "ok" } | { status: "degraded"; database: "unreachable" };
}

export interface HealthOptions {
  /** Longest the probe waits for the database. Default 2 s. */
  timeoutMs?: number;
  /** Called with the real reason when the check fails; the reply never carries it. */
  onFailure?: (error: unknown) => void;
}

/**
 * Whether the platform can serve: the database answers. The reply is the same short body whatever went wrong, so a
 * probe (which anyone on the network may be) learns nothing about hosts, users or errors; the reason is for the log.
 */
export async function checkHealth(ping: () => Promise<unknown>, options: HealthOptions = {}): Promise<HealthReply> {
  const timeoutMs = options.timeoutMs ?? 2_000;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(ping),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`the database did not answer within ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
    return { status: 200, body: { status: "ok", database: "ok" } };
  } catch (error) {
    options.onFailure?.(error);
    return { status: 503, body: { status: "degraded", database: "unreachable" } };
  } finally {
    clearTimeout(timer);
  }
}
