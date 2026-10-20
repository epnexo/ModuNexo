/** Anything that runs a parameterised statement: a pool, a client in a transaction, or a module's transaction handle. */
export interface Executor {
  query(sql: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}
