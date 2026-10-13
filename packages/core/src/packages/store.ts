import type pg from "pg";

export interface IntakeRecord {
  sha256: string;
  moduleId: string | null;
  version: string | null;
  sizeBytes: number;
  status: "staged" | "refused";
  /** Why it was refused; null for a staged package. */
  problems: string[] | null;
  actor: string;
}

export interface IntakeRow extends IntakeRecord {
  id: number;
  receivedAt: Date;
}

export async function recordIntake(pool: pg.Pool, record: IntakeRecord): Promise<void> {
  await pool.query(
    `insert into core.module_packages (sha256, module_id, version, size_bytes, status, problems, actor)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [record.sha256, record.moduleId, record.version, record.sizeBytes, record.status, record.problems === null ? null : JSON.stringify(record.problems), record.actor],
  );
}

/** Intakes, newest first, optionally of one module or one archive. */
export async function listIntakes(pool: pg.Pool, filter: { moduleId?: string; sha256?: string; limit?: number } = {}): Promise<IntakeRow[]> {
  const { rows } = await pool.query(
    `select id, sha256, module_id, version, size_bytes, status, problems, actor, received_at
       from core.module_packages
      where ($1::text is null or module_id = $1) and ($2::text is null or sha256 = $2)
      order by received_at desc, id desc
      limit $3`,
    [filter.moduleId ?? null, filter.sha256 ?? null, filter.limit ?? 100],
  );
  return rows.map((row) => ({
    id: Number(row.id),
    sha256: row.sha256,
    moduleId: row.module_id,
    version: row.version,
    sizeBytes: Number(row.size_bytes),
    status: row.status,
    problems: row.problems,
    actor: row.actor,
    receivedAt: row.received_at,
  }));
}
