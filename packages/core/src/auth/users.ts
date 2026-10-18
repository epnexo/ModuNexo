import type pg from "pg";
import { ADMIN_ROLE, type Auth, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, ROLES, type Role } from "./auth.ts";

/** The request was understood and refused by a rule; nothing was changed. The message never contains the password. */
export class AdminRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminRefusedError";
  }
}

export interface NewUser {
  email: string;
  name: string;
  password: string;
  role: Role;
}

export interface CreatedUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export interface UserSummary {
  email: string;
  name: string;
  /** Whatever the database holds; a role this version does not know holds no permission. */
  role: string;
  banned: boolean;
}

export const isRole = (value: unknown): value is Role => typeof value === "string" && (ROLES as readonly string[]).includes(value);

const roleList = ROLES.join(" or ");
const codeOf = (error: unknown): string | undefined => (error as { body?: { code?: string } } | null)?.body?.code;
const normalise = (email: string) => email.trim().toLowerCase();

/**
 * Creates a user with the given role. Public sign-up is disabled, so this server-side call is how every user exists.
 * It never goes through an HTTP request, so no session is required.
 */
export async function createUser(auth: Auth, input: NewUser): Promise<CreatedUser> {
  const email = normalise(input.email);
  const name = input.name.trim();
  if (!isRole(input.role)) throw new AdminRefusedError(`the role must be ${roleList}`);
  if (name === "") throw new AdminRefusedError("a name is required");
  if (input.password.length < PASSWORD_MIN_LENGTH) throw new AdminRefusedError(`the password must be at least ${PASSWORD_MIN_LENGTH} characters`);
  if (input.password.length > PASSWORD_MAX_LENGTH) throw new AdminRefusedError(`the password must be at most ${PASSWORD_MAX_LENGTH} characters`);

  try {
    const { user } = await auth.api.createUser({ body: { email, name, password: input.password, role: input.role as never } });
    return { id: user.id, email: user.email, name: user.name, role: input.role };
  } catch (error) {
    const code = codeOf(error);
    if (code === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL") throw new AdminRefusedError(`a user with the email "${email}" already exists`);
    if (code === "INVALID_EMAIL") throw new AdminRefusedError(`"${email}" is not a valid email address`);
    throw error;
  }
}

/** Every user, by email. */
export async function listUsers(pool: pg.Pool): Promise<UserSummary[]> {
  const { rows } = await pool.query(`select "email", "name", coalesce("role", '') as role, coalesce("banned", false) as banned from core.auth_user order by "email"`);
  return rows.map((row) => ({ email: row.email, name: row.name, role: row.role, banned: row.banned }));
}

export interface RoleChange {
  email: string;
  role: Role;
  /** False when the user already had this role and nothing was written. */
  changed: boolean;
}

const LOCK_KEY = "core.auth_user.roles";

/**
 * Changes a user's role. The platform must always keep one active (not banned) administrator, so demoting the last
 * one is refused. The check and the write share one transaction behind an advisory lock, so two concurrent demotions
 * cannot both pass the check.
 */
export async function setUserRole(pool: pg.Pool, emailInput: string, role: Role): Promise<RoleChange> {
  if (!isRole(role)) throw new AdminRefusedError(`the role must be ${roleList}`);
  const email = normalise(emailInput);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [LOCK_KEY]);
    const found = await client.query(`select "role", coalesce("banned", false) as banned from core.auth_user where "email" = $1`, [email]);
    if (found.rows.length === 0) throw new AdminRefusedError(`there is no user with the email "${email}"`);
    if (found.rows[0].role === role) {
      await client.query("commit");
      return { email, role, changed: false };
    }
    if (found.rows[0].role === ADMIN_ROLE && !found.rows[0].banned) {
      const others = await client.query(`select count(*)::int as n from core.auth_user where "role" = $1 and coalesce("banned", false) = false and "email" <> $2`, [ADMIN_ROLE, email]);
      if (others.rows[0].n === 0) {
        throw new AdminRefusedError(`"${email}" is the last administrator: make another user an administrator first, so you cannot be locked out`);
      }
    }
    await client.query(`update core.auth_user set "role" = $1, "updatedAt" = now() where "email" = $2`, [role, email]);
    await client.query("commit");
    return { email, role, changed: true };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
