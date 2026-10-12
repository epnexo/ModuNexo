import { type BetterAuthPlugin, betterAuth } from "better-auth";
import { admin } from "better-auth/plugins/admin";
import { PostgresDialect } from "kysely";
import type pg from "pg";
import { deriveSecret } from "./master-key.ts";

/** Shortest password the platform accepts. The library's own minimum is lower and is not applied on every path. */
export const PASSWORD_MIN_LENGTH = 12;
/** The library's own ceiling: longer input is refused before hashing. */
export const PASSWORD_MAX_LENGTH = 128;
/** The role that holds every permission. The only role this version of the shell knows. */
export const ADMIN_ROLE = "admin";

/** Failed sign-ins allowed per client address in `SIGN_IN_WINDOW_SECONDS` before the endpoint answers 429. */
export const SIGN_IN_MAX_ATTEMPTS = 5;
export const SIGN_IN_WINDOW_SECONDS = 60;

export interface AuthConfig {
  /** The platform pool. It is shared, never closed by the auth layer. */
  pool: pg.Pool;
  /** `EPNEXO_MASTER_KEY`; the library's signing secret is derived from it. */
  masterKey: string;
  /** The origin the web app is served from. Without it the library infers the origin from each request. */
  baseURL?: string;
  /** Extra origins allowed to call the auth endpoints, besides `baseURL`. */
  trustedOrigins?: string[];
  /** Plugins the host adds after the platform's own, such as the Next.js cookie plugin. */
  plugins?: BetterAuthPlugin[];
}

/**
 * The platform's authentication: email and password, no public sign-up, tables in the `core` schema with the
 * `auth_` prefix (created by the core migration `0003_auth.sql`, never by the library's own migrate command).
 */
export function createAuth(config: AuthConfig) {
  return betterAuth({
    appName: "epnexo",
    secret: deriveSecret(config.masterKey, "auth"),
    ...(config.baseURL === undefined ? {} : { baseURL: config.baseURL }),
    ...(config.trustedOrigins === undefined ? {} : { trustedOrigins: config.trustedOrigins }),
    database: { dialect: new PostgresDialect({ pool: config.pool }), type: "postgres", schemaName: "core" },
    user: { modelName: "auth_user" },
    session: { modelName: "auth_session" },
    account: { modelName: "auth_account" },
    verification: { modelName: "auth_verification" },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      modelName: "auth_rate_limit",
      customRules: { "/sign-in/email": { window: SIGN_IN_WINDOW_SECONDS, max: SIGN_IN_MAX_ATTEMPTS } },
    },
    telemetry: { enabled: false },
    plugins: [admin({ defaultRole: "user", adminRoles: [ADMIN_ROLE] }), ...(config.plugins ?? [])],
  });
}

export type Auth = ReturnType<typeof createAuth>;
