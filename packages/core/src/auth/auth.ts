import { type BetterAuthPlugin, betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { admin } from "better-auth/plugins/admin";
import { PostgresDialect } from "kysely";
import type pg from "pg";
import { isLastActiveAdmin } from "./last-admin.ts";
import { deriveSecret } from "./master-key.ts";

/** Shortest password the platform accepts. The library's own minimum is lower and is not applied on every path. */
export const PASSWORD_MIN_LENGTH = 12;
/** The library's own ceiling: longer input is refused before hashing. */
export const PASSWORD_MAX_LENGTH = 128;
/** The role that holds every permission and may change the platform. */
export const ADMIN_ROLE = "admin";
/** The role that uses the modules (holds every module permission) but cannot change the platform. */
export const OPERATOR_ROLE = "operator";
/** The roles a user can be given. Any other stored role (the library's default "user") holds nothing. */
export const ROLES = [ADMIN_ROLE, OPERATOR_ROLE] as const;
export type Role = (typeof ROLES)[number];

/** The library endpoints that can take an administrator away. */
const LAST_ADMIN_GUARDED = new Set(["/admin/set-role", "/admin/ban-user", "/admin/remove-user"]);

/** Failed sign-ins allowed per client address in `SIGN_IN_WINDOW_SECONDS` before the endpoint answers 429. */
export const SIGN_IN_MAX_ATTEMPTS = 5;
export const SIGN_IN_WINDOW_SECONDS = 60;

/**
 * The one request header the sign-in rate limiter keys on. The web server sets it from the connection's own
 * address and strips any copy a client sent, so it cannot be forged. The library's default is to trust
 * `x-forwarded-for` and similar headers, which a client controls: rotating one would defeat the limit.
 */
export const CLIENT_IP_HEADER = "x-epnexo-client-ip";

/**
 * Trusts a browser request whose `Origin` names the host the request was sent to (the `Host` header). The web app
 * is reached under whatever name the owner uses, so no base URL can be fixed in advance. A page on another site
 * cannot send a matching pair: the browser sets both headers and the attacker controls neither. Forwarding headers
 * are deliberately not consulted, since a client can write them.
 */
function sameOrigin(request?: Request): string[] {
  const origin = request?.headers.get("origin");
  const host = request?.headers.get("host");
  if (!origin || !host) return [];
  try {
    return new URL(origin).host === host ? [origin] : [];
  } catch {
    return [];
  }
}

export interface AuthConfig {
  /** The platform pool. It is shared, never closed by the auth layer. */
  pool: pg.Pool;
  /** `EPNEXO_MASTER_KEY`; the library's signing secret is derived from it. */
  masterKey: string;
  /** The origin the web app is served from. Without it the library infers the origin from each request. */
  baseURL?: string;
  /** Extra origins allowed to call the auth endpoints, besides `baseURL`. */
  trustedOrigins?: string[];
  /**
   * Whether session cookies carry the Secure attribute. A browser refuses to keep a Secure cookie that came over
   * plain HTTP from anything but localhost, so the default is false: the shell must sign in on a local network
   * address. Set it true when the app is served over HTTPS.
   */
  secureCookies?: boolean;
  /**
   * The library checks the database schema in the background when it is created, and a long-running server wants
   * that: authentication requests fail loudly on a mismatch. A short command that exits right after creating a
   * user does not, because the check would race the pool being closed. Default: the library's own (on).
   */
  validateSchema?: boolean;
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
    trustedOrigins: async (request) => [...(config.trustedOrigins ?? []), ...sameOrigin(request)],
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
    advanced: {
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
      useSecureCookies: config.secureCookies ?? false,
      ...(config.validateSchema === undefined ? {} : { database: { validateSchema: config.validateSchema } }),
    },
    hooks: {
      // The library's admin endpoints let an administrator demote, ban or remove users. None of them may take the
      // last active administrator away, whoever asks (the command line enforces the same rule in `setUserRole`).
      before: createAuthMiddleware(async (ctx) => {
        if (!LAST_ADMIN_GUARDED.has(ctx.path)) return;
        const body = (ctx.body ?? {}) as { userId?: unknown; role?: unknown };
        if (typeof body.userId !== "string") return;
        const keepsAdmin = ctx.path === "/admin/set-role" && (body.role === ADMIN_ROLE || (Array.isArray(body.role) && body.role.includes(ADMIN_ROLE)));
        if (keepsAdmin) return;
        if (await isLastActiveAdmin(config.pool, body.userId, ADMIN_ROLE)) {
          throw new APIError("BAD_REQUEST", { message: "This is the last active administrator: make another user an administrator first, so you cannot be locked out." });
        }
      }),
    },
    telemetry: { enabled: false },
    plugins: [admin({ defaultRole: "user", adminRoles: [ADMIN_ROLE] }), ...(config.plugins ?? [])],
  });
}

export type Auth = ReturnType<typeof createAuth>;
