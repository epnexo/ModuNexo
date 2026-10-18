import { ADMIN_ROLE, type Auth } from "./auth.ts";
import { AdminRefusedError, createUser } from "./users.ts";

export { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "./auth.ts";
export { AdminRefusedError };

export interface NewAdministrator {
  email: string;
  name: string;
  password: string;
}

export interface CreatedAdministrator {
  id: string;
  email: string;
  name: string;
}

/**
 * Creates a user with the admin role. Public sign-up is disabled, so this is how the first administrator exists.
 * It is a trusted, server-side call: it never goes through an HTTP request, so no session is required.
 */
export async function createAdministrator(auth: Auth, input: NewAdministrator): Promise<CreatedAdministrator> {
  const { id, email, name } = await createUser(auth, { ...input, role: ADMIN_ROLE });
  return { id, email, name };
}
