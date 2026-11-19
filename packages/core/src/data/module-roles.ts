import { createHash, createHmac, pbkdf2Sync } from "node:crypto";
import type pg from "pg";
import { deriveSecret } from "../auth/master-key.ts";
import { createPool } from "../pool.ts";
import { quoteIdentifier } from "../sql.ts";

/** Held while a role is set up, so two processes starting together do not both create it. */
const ROLE_LOCK = 7_302_202;
const SCRAM_ITERATIONS = 4096;
const DEFAULT_MAX_CONNECTIONS = 3;
const DEFAULT_IDLE_MS = 30_000;
const CONNECT_TIMEOUT_MS = 5000;
const INSUFFICIENT_PRIVILEGE = "42501";

/** The platform cannot give a module a role of its own. The message never carries a password or the master key. */
export class ModuleRoleError extends Error {
  constructor(
    readonly code: "cannot-create-role" | "closed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ModuleRoleError";
  }
}

/** The login role of a module: `mnx_m_<schema>`, or a digest of the schema when that would not fit in 63 characters. */
export function moduleRoleName(schema: string): string {
  const name = `mnx_m_${schema}`;
  return name.length <= 63 ? name : `mnx_m_${createHash("sha256").update(schema).digest("hex").slice(0, 40)}`;
}

/**
 * What Postgres stores for a password, computed here so the password itself never travels in a statement the server
 * may log. The salt is derived too, so the same key and schema always give the same verifier.
 */
function scramVerifier(password: string, salt: Buffer): string {
  const salted = pbkdf2Sync(password, salt, SCRAM_ITERATIONS, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${SCRAM_ITERATIONS}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

/** A pool that was ended already is left alone: `pg` throws when asked twice. */
async function endPool(pool: pg.Pool | undefined): Promise<void> {
  if (pool !== undefined && !pool.ended) await pool.end();
}

export interface ModuleRolesOptions {
  /** The platform's own pool, whose user creates the roles and is made a member of each. */
  pool: pg.Pool;
  /** The platform's connection string: a module pool uses the same server and database with the module's login. */
  connectionString: string;
  /** The password of every module is derived from this key; nothing about it is stored. */
  masterKey: string;
  /** Per module pool. Default 3. */
  maxConnections?: number;
  /** How long an idle connection of a module pool stays open. Default 30 s. */
  idleTimeoutMs?: number;
}

/**
 * A Postgres login of its own for every module. A module's pool connects as that role, so the session itself belongs to
 * the module and there is no other user for it to return to; what it may touch is what the database grants the role.
 * Roles belong to the cluster, not to one database.
 */
export class ModuleRoles {
  readonly #ensured = new Map<string, Promise<string>>();
  readonly #pools = new Map<string, Promise<pg.Pool>>();
  #closed = false;

  constructor(private readonly options: ModuleRolesOptions) {}

  #password(schema: string): { password: string; verifier: string } {
    const password = deriveSecret(this.options.masterKey, `db:${schema}`);
    const salt = Buffer.from(deriveSecret(this.options.masterKey, `db-salt:${schema}`).slice(0, 32), "hex");
    return { password, verifier: scramVerifier(password, salt) };
  }

  /** Creates the role, or sets its password to the one the master key gives, and makes the platform a member. Returns the role's name. */
  ensure(schema: string): Promise<string> {
    let ready = this.#ensured.get(schema);
    if (ready === undefined) {
      ready = this.#create(schema);
      this.#ensured.set(schema, ready);
      ready.catch(() => this.#ensured.delete(schema));
    }
    return ready;
  }

  async #create(schema: string): Promise<string> {
    const role = moduleRoleName(schema);
    const quotedRole = quoteIdentifier(role);
    quoteIdentifier(schema);
    // Built from a validated schema name and a base64 verifier: neither holds a quote.
    const { verifier } = this.#password(schema);
    const client = await this.options.pool.connect();
    let broken = false;
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock($1)", [ROLE_LOCK]);
      const exists = (await client.query("select 1 from pg_roles where rolname = $1", [role])).rowCount === 1;
      await client.query(exists ? `alter role ${quotedRole} login password '${verifier}'` : `create role ${quotedRole} login password '${verifier}'`);
      await client.query(`grant ${quotedRole} to current_user`);
      await client.query("commit");
      return role;
    } catch (error) {
      await client.query("rollback").catch(() => {
        broken = true;
      });
      if ((error as { code?: string }).code === INSUFFICIENT_PRIVILEGE) {
        throw new ModuleRoleError(
          "cannot-create-role",
          `cannot give module schema "${schema}" a database login of its own: the database user must be able to create roles (the CREATEROLE attribute, or a superuser)`,
          { cause: error },
        );
      }
      throw error;
    } finally {
      client.release(broken ? true : undefined);
    }
  }

  /** The module's pool: small, logged in as the module's role, and the same one every time. */
  pool(schema: string): Promise<pg.Pool> {
    if (this.#closed) return Promise.reject(new ModuleRoleError("closed", "the module roles were closed"));
    let pool = this.#pools.get(schema);
    if (pool === undefined) {
      pool = this.ensure(schema).then((role) => {
        const target = new URL(this.options.connectionString);
        target.username = role;
        target.password = this.#password(schema).password;
        return createPool(target.toString(), {
          max: this.options.maxConnections ?? DEFAULT_MAX_CONNECTIONS,
          idleTimeoutMillis: this.options.idleTimeoutMs ?? DEFAULT_IDLE_MS,
          connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
        });
      });
      this.#pools.set(schema, pool);
      pool.catch(() => this.#pools.delete(schema));
    }
    return pool;
  }

  /** Ends the module's pool and drops its role and everything it owns, its schema included. A role that is not there is not an error. */
  async drop(schema: string): Promise<void> {
    const pool = this.#pools.get(schema);
    this.#pools.delete(schema);
    this.#ensured.delete(schema);
    await endPool(await pool?.catch(() => undefined));
    const role = moduleRoleName(schema);
    if ((await this.options.pool.query("select 1 from pg_roles where rolname = $1", [role])).rowCount === 0) return;
    const quotedRole = quoteIdentifier(role);
    await this.options.pool.query(`drop owned by ${quotedRole}`);
    await this.options.pool.query(`drop role ${quotedRole}`);
  }

  /** Ends every module pool. The platform's own pool is not touched. */
  async close(): Promise<void> {
    this.#closed = true;
    const pools = [...this.#pools.values()];
    this.#pools.clear();
    await Promise.all(pools.map(async (pool) => endPool(await pool.catch(() => undefined))));
  }
}
