/** The parts of a user record that decide whether an existing session may still be used. */
export interface SessionUser {
  banned?: boolean | null;
  banExpires?: Date | string | null;
}

/**
 * Whether a session found for this user may be used. The library keeps a banned user's sessions alive unless its
 * own ban call revoked them, and a ban written straight to the database does not, so the gate asks again on every
 * request. A ban with no expiry, a future expiry or an expiry that cannot be read is in force.
 */
export function sessionIsUsable(user: SessionUser, now: Date = new Date()): boolean {
  if (user.banned !== true) return true;
  const expires = user.banExpires;
  if (expires === null || expires === undefined) return false;
  const at = expires instanceof Date ? expires : new Date(expires);
  if (Number.isNaN(at.getTime())) return false;
  return at.getTime() <= now.getTime();
}
