import { DbAccessError, type DbQueryable, type DbReadOnly, type DbReader, type DbResult, type ModuleDb } from "@modunexo/sdk";
import type pg from "pg";
import { CORE_MODULE_ID } from "../core-module.ts";
import type { Registry } from "../registry.ts";
import { quoteIdentifier } from "../sql.ts";

export interface ModuleDbOptions {
  /** Longest a single statement may run before the database cancels it. Default 30 s. */
  statementTimeoutMs?: number;
}

interface Scope {
  /** The schema `search_path` is fixed to for every statement. */
  schema: string;
  /** Modules that must be enabled for the call to run: the one whose data is touched, and the caller. */
  requires: string[];
  readOnly: boolean;
}

/**
 * What the SDK's `getDb` hands a module. Each call runs in its own transaction on its own connection with
 * `search_path` fixed to the module's schema for that transaction only (`set_config(..., true)`), so nothing leaks to
 * the next user of the pooled connection. A handle to another module is `READ ONLY` at the database, and exists only
 * when the caller lists that module in `dependsOn`. Statements use the extended protocol, so one call is one
 * statement and SQL cannot end the transaction and carry on outside it.
 *
 * This is the contract for well-behaved modules, not a sandbox: module code runs in this process with these
 * credentials.
 */
export class ModuleDbService implements DbReader {
  readonly #timeoutMs: number;

  constructor(
    private readonly pool: pg.Pool,
    private readonly registry: Registry,
    options: ModuleDbOptions = {},
  ) {
    this.#timeoutMs = options.statementTimeoutMs ?? 30_000;
  }

  forModule(moduleId: string): ModuleDb {
    const manifest = this.registry.get(moduleId);
    if (manifest === undefined || moduleId === CORE_MODULE_ID) {
      throw new DbAccessError("unknown-module", `module "${moduleId}" is not part of this build, so it has no data to reach`);
    }
    const own: Scope = { schema: manifest.schema, requires: [moduleId], readOnly: false };
    return {
      query: (sql, params) => this.#transaction(own, (tx) => tx.query(sql, params)),
      transaction: (run) => this.#transaction(own, run),
      reader: (otherId): DbReadOnly => {
        if (!Object.hasOwn(manifest.dependsOn, otherId)) {
          throw new DbAccessError("not-a-dependency", `module "${moduleId}" cannot read "${otherId}": it is not listed in dependsOn`);
        }
        const other = this.registry.get(otherId);
        if (other === undefined) throw new DbAccessError("unknown-module", `module "${otherId}" is not part of this build, so it has no data to reach`);
        const scope: Scope = { schema: other.schema, requires: [otherId, moduleId], readOnly: true };
        return { query: (sql, params) => this.#transaction(scope, (tx) => tx.query(sql, params)) };
      },
    };
  }

  /**
   * A READ ONLY handle on the module's own schema, for statements the platform runs on the module's behalf, such as
   * the ones it declares for the dashboard. The database itself refuses a write through it.
   */
  readOwn(moduleId: string): DbReadOnly {
    const manifest = this.registry.get(moduleId);
    if (manifest === undefined || moduleId === CORE_MODULE_ID) {
      throw new DbAccessError("unknown-module", `module "${moduleId}" is not part of this build, so it has no data to reach`);
    }
    const scope: Scope = { schema: manifest.schema, requires: [moduleId], readOnly: true };
    return { query: (sql, params) => this.#transaction(scope, (tx) => tx.query(sql, params)) };
  }

  async #transaction<T>(scope: Scope, run: (tx: DbQueryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let broken = false;
    let open = true;
    try {
      await client.query(scope.readOnly ? "begin read only" : "begin");
      await client.query("select set_config('search_path', $1, true), set_config('statement_timeout', $2, true)", [
        quoteIdentifier(scope.schema),
        String(this.#timeoutMs),
      ]);
      const wanted = [...new Set(scope.requires)];
      const enabled = await client.query("select id from core.modules where id = any($1) and state = 'enabled'", [wanted]);
      const have = new Set((enabled.rows as { id: string }[]).map((row) => row.id));
      for (const id of wanted) {
        if (!have.has(id)) throw new DbAccessError("not-enabled", `module "${id}" is not installed and enabled`);
      }
      const tx: DbQueryable = {
        query: async <Row extends Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<DbResult<Row>> => {
          if (!open) throw new DbAccessError("closed", "this handle was used after its transaction ended");
          const result = await client.query({ text: sql, values: [...params], queryMode: "extended" } as pg.QueryConfig);
          return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 };
        },
      };
      const value = await run(tx);
      await client.query("commit");
      return value;
    } catch (error) {
      await client.query("rollback").catch(() => {
        broken = true;
      });
      throw error;
    } finally {
      open = false;
      client.release(broken ? true : undefined);
    }
  }
}
