import type pg from "pg";

/**
 * A pool whose connections reject any statement `shouldFail` accepts, with an error of their own; everything
 * else reaches the real database. Used to fail one precise step of a lifecycle action.
 */
export function faultyPool(pool: pg.Pool, shouldFail: (sql: string) => boolean, message = "injected failure"): pg.Pool {
  const wrapClient = (client: pg.PoolClient): pg.PoolClient =>
    new Proxy(client, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (property !== "query") return typeof value === "function" ? value.bind(target) : value;
        return (...args: unknown[]) => {
          const first = args[0];
          const sql = typeof first === "string" ? first : ((first as { text?: string } | undefined)?.text ?? "");
          return shouldFail(sql) ? Promise.reject(new Error(message)) : (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
  return new Proxy(pool, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (property === "connect") return async () => wrapClient(await target.connect());
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
