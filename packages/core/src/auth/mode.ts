import type pg from "pg";

/**
 * Whether the shell asks for a sign-in. `required` is the default and the only value anything unknown resolves to.
 * `disabled` exists for an instance that lives on a trusted local network; the shell then serves local requests
 * only (see `requestIsLocal`) and acts as a local operator who holds every permission.
 */
export type SignInMode = "required" | "disabled";

const KEY = "auth.signIn";

/** The change was understood and refused by a rule; nothing was changed. */
export class ModeRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModeRefusedError";
  }
}

/**
 * The current mode. A missing row means `required`, and so does any stored value that is not exactly "disabled":
 * a corrupted or hand-edited row must never open the shell. A database error is not caught here; the caller is a
 * request guard and denies the request when it cannot find out.
 */
export async function readSignInMode(pool: pg.Pool): Promise<SignInMode> {
  const { rows } = await pool.query("select value from core.platform_settings where key = $1", [KEY]);
  return rows[0]?.value === "disabled" ? "disabled" : "required";
}

export interface ModeChange {
  mode: SignInMode;
  /** False when the instance already had this mode and nothing was written. */
  changed: boolean;
}

/**
 * Sets the mode. Requiring sign-in is refused while no active administrator exists, so switching it on can never
 * lock the owner out. The check and the write share one transaction.
 */
export async function setSignInMode(pool: pg.Pool, mode: SignInMode, actor: string): Promise<ModeChange> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    // Serialises concurrent changes, so two commands cannot both pass the check and then disagree.
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [KEY]);
    const current = await client.query("select value from core.platform_settings where key = $1", [KEY]);
    const existing: SignInMode = current.rows[0]?.value === "disabled" ? "disabled" : "required";
    // The effective mode already is the requested one: nothing to check and nothing to write. This also covers a
    // fresh instance, where "required" is the default and no row exists.
    if (existing === mode) {
      await client.query("commit");
      return { mode, changed: false };
    }
    if (mode === "required") {
      const admins = await client.query(`select count(*)::int as n from core.auth_user where "role" = 'admin' and coalesce("banned", false) = false`);
      if (admins.rows[0].n === 0) {
        throw new ModeRefusedError('no administrator exists, so requiring sign-in would lock you out: create one first with "npm run epnexo -- admin create"');
      }
    }
    await client.query(
      `insert into core.platform_settings (key, value, updated_by) values ($1, to_jsonb($2::text), $3)
       on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by`,
      [KEY, mode, actor],
    );
    await client.query("commit");
    return { mode, changed: true };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
