/**
 * How a module's server code reaches its own data. The SDK holds no database code: the platform registers a reader
 * under a global symbol when the web app starts and `getDb` asks it, the same way `getSetting` does. A symbol and
 * not an import, so every copy of the SDK a bundler produces finds the same reader.
 *
 * What the platform guarantees through this API:
 * - a module's handle runs every statement inside one transaction whose `search_path` is the module's own schema;
 * - `reader(other)` is a READ ONLY handle on another module's schema, and only for a module the caller lists in its
 *   manifest `dependsOn`; a write through it is refused by the database itself;
 * - a module that is not installed and enabled gets no handle.
 *
 * This is the platform's contract for well-behaved modules, not a sandbox: module code runs in the platform's own
 * process with the platform's database credentials, so a module that wants to can still reach around it.
 */
export const DB_READER: unique symbol = Symbol.for("modunexo.db.reader") as never;

/** One statement's outcome. Rows are plain objects keyed by column name. */
export interface DbResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  rows: Row[];
  rowCount: number;
}

/** Something that can run a parameterised statement. Use `$1`, `$2`, ... placeholders; never build SQL from input. */
export interface DbQueryable {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<DbResult<Row>>;
}

/** A read-only view of another module's schema. */
export type DbReadOnly = DbQueryable;

/** A module's own data. Unqualified table names resolve in the module's schema. */
export interface ModuleDb extends DbQueryable {
  /** Run several statements as one unit: all of them commit, or none does. A thrown error rolls everything back. */
  transaction<T>(run: (tx: DbQueryable) => Promise<T>): Promise<T>;
  /**
   * A READ ONLY handle on another module's schema. The other module must be in this module's manifest `dependsOn`
   * and be enabled; anything else throws `DbAccessError`.
   */
  reader(otherModuleId: string): DbReadOnly;
}

/** What the platform registers: it hands out a module's handle. */
export interface DbReader {
  forModule(moduleId: string): ModuleDb;
}

export type DbAccessCode =
  /** No such module in this build. */
  | "unknown-module"
  /** The module is known but not installed and enabled. */
  | "not-enabled"
  /** `reader` named a module the caller does not list in `dependsOn`. */
  | "not-a-dependency"
  /** The handle was used after its transaction ended. */
  | "closed";

/** The platform refused to give a module access to some data. `code` says why. */
export class DbAccessError extends Error {
  readonly code: DbAccessCode;

  constructor(code: DbAccessCode, message: string) {
    super(message);
    this.name = "DbAccessError";
    this.code = code;
  }
}

/** `getDb` ran where the platform has not registered a reader: a script, a test, a build step. */
export class DbUnavailableError extends Error {
  constructor() {
    super("module data can only be reached while the platform is serving a request: no database reader is registered in this process");
    this.name = "DbUnavailableError";
  }
}

/** The data handle of one module. Call it from a page, a server component or an API route, never at import time. */
export function getDb(moduleId: string): ModuleDb {
  const reader = (globalThis as typeof globalThis & { [DB_READER]?: DbReader })[DB_READER];
  if (reader === undefined) throw new DbUnavailableError();
  return reader.forModule(moduleId);
}
