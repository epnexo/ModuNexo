import type pg from "pg";

/**
 * Is this user the only active (not banned) administrator? Used by the HTTP path (the library's own admin endpoints),
 * which would otherwise let that user demote, ban or remove themselves and leave the platform without one.
 */
export async function isLastActiveAdmin(pool: pg.Pool, userId: string, adminRole: string): Promise<boolean> {
  const { rows } = await pool.query(
    `select
       exists (select 1 from core.auth_user where "id" = $1 and "role" = $2 and coalesce("banned", false) = false) as is_admin,
       exists (select 1 from core.auth_user where "id" <> $1 and "role" = $2 and coalesce("banned", false) = false) as has_other`,
    [userId, adminRole],
  );
  return rows[0].is_admin === true && rows[0].has_other === false;
}
