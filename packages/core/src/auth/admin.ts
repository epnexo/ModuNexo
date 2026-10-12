import { ADMIN_ROLE, type Auth, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "./auth.ts";

export { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "./auth.ts";

/** The request was understood and refused by a rule; no user was created. The message never contains the password. */
export class AdminRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdminRefusedError";
  }
}

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

const codeOf = (error: unknown): string | undefined => (error as { body?: { code?: string } } | null)?.body?.code;

/**
 * Creates a user with the admin role. Public sign-up is disabled, so this is how the first administrator exists.
 * It is a trusted, server-side call: it never goes through an HTTP request, so no session is required.
 */
export async function createAdministrator(auth: Auth, input: NewAdministrator): Promise<CreatedAdministrator> {
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();
  if (name === "") throw new AdminRefusedError("a name is required");
  if (input.password.length < PASSWORD_MIN_LENGTH) throw new AdminRefusedError(`the password must be at least ${PASSWORD_MIN_LENGTH} characters`);
  if (input.password.length > PASSWORD_MAX_LENGTH) throw new AdminRefusedError(`the password must be at most ${PASSWORD_MAX_LENGTH} characters`);

  try {
    const { user } = await auth.api.createUser({ body: { email, name, password: input.password, role: ADMIN_ROLE } });
    return { id: user.id, email: user.email, name: user.name };
  } catch (error) {
    const code = codeOf(error);
    if (code === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL") throw new AdminRefusedError(`a user with the email "${email}" already exists`);
    if (code === "INVALID_EMAIL") throw new AdminRefusedError(`"${email}" is not a valid email address`);
    throw error;
  }
}
