import { createHash, createHmac, pbkdf2Sync } from "node:crypto";
import type pg from "pg";
import type { ModuleManifest } from "@modunexo/sdk";
import { deriveSecret, resolveMasterKey } from "../auth/master-key.ts";
import { createPool, resolveDatabaseUrl } from "../pool.ts";
import { CORE_MODULE_ID } from "../core-module.ts";
import type { Executor } from "../executor.ts";
import type { Registry } from "../registry.ts";
import { quoteIdentifier } from "../sql.ts";

/** What a module's login may call in `core`, and nothing else there. Each takes the module from the login, never from an argument. */
const MODULE_FUNCTIONS = [
  "core.record_migration(text, text)",
  "core.publish_event(text, jsonb)",
  "core.enqueue_job(text, jsonb, timestamptz, text)",
  "core.record_file(uuid, text, text, bigint, text, text, timestamptz)",
];

/** Whether the connection behind `db` is logged in as a module's role, so its writes to `core` must go through the functions above. */
export async function isModuleLogin(db: Executor): Promise<boolean> {
  const { rows } = await db.query("select session_user::text as login");
  return String(rows[0]?.login ?? "").startsWith("mnx_m_");
}

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

  /**
   * Makes the module's login ready to run its own migrations: the role exists, the platform knows which module it
   * belongs to, the role can call `core.record_migration` and nothing else in `core`, and it owns its schema. Run it
   * on the platform's connection, under the migration lock. A schema that already exists with another owner is the
   * adoption of an installed module, which this does not do.
   */
  async provision(client: pg.PoolClient, moduleId: string, schema: string): Promise<string> {
    const role = await this.ensure(schema);
    const quotedRole = quoteIdentifier(role);
    const quotedSchema = quoteIdentifier(schema);
    await client.query(
      "insert into core.module_roles (role_name, module_id, schema_name) values ($1, $2, $3) on conflict (role_name) do update set module_id = excluded.module_id, schema_name = excluded.schema_name",
      [role, moduleId, schema],
    );
    await client.query(`grant usage on schema core to ${quotedRole}`);
    for (const signature of MODULE_FUNCTIONS) await client.query(`grant execute on function ${signature} to ${quotedRole}`);
    await client.query(`create schema if not exists ${quotedSchema} authorization ${quotedRole}`);
    return role;
  }

  /**
   * Makes what a module may read in other modules' schemas match its `dependsOn`: `SELECT` on every table of a
   * dependency, now and for tables that dependency creates later, and nothing on any other module. Run on the platform's
   * connection after `provision`, so the dependencies already have their roles.
   */
  async syncReads(client: pg.PoolClient, manifest: ModuleManifest, registry: Registry): Promise<void> {
    const own = quoteIdentifier(moduleRoleName(manifest.schema));
    for (const other of registry.all()) {
      if (other.id === manifest.id || other.id === CORE_MODULE_ID) continue;
      const roleName = moduleRoleName(other.schema);
      // A module that is not installed here has no schema in this database; its role may still exist, roles belong to the cluster.
      const there = await client.query("select exists (select 1 from pg_roles where rolname = $1) and exists (select 1 from pg_namespace where nspname = $2) as present", [roleName, other.schema]);
      if (there.rows[0].present !== true) continue;
      const schema = quoteIdentifier(other.schema);
      const owner = quoteIdentifier(roleName);
      if (Object.hasOwn(manifest.dependsOn, other.id)) {
        await client.query(`grant usage on schema ${schema} to ${own}`);
        await client.query(`grant select on all tables in schema ${schema} to ${own}`);
        await client.query(`alter default privileges for role ${owner} in schema ${schema} grant select on tables to ${own}`);
      } else {
        await client.query(`alter default privileges for role ${owner} in schema ${schema} revoke select on tables from ${own}`);
        await client.query(`revoke select on all tables in schema ${schema} from ${own}`);
        await client.query(`revoke usage on schema ${schema} from ${own}`);
      }
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

const SHARED = new WeakMap<pg.Pool, ModuleRoles>();

/**
 * The module roles of a platform pool: one per pool and process, built from the environment the platform already
 * needs (the database URL and the master key), so every part of the platform that has a pool gets the same one. Ending
 * the pool first ends the module pools, so no process is held open by a login that is no longer used. A missing master
 * key refuses here, with no fallback to the platform's own credentials.
 */
export function moduleRolesFor(pool: pg.Pool): ModuleRoles {
  let roles = SHARED.get(pool);
  if (roles === undefined) {
    // The pool's own connection string, so the module logins reach the same server and database as the platform does.
    const own = (pool as unknown as { options?: { connectionString?: string } }).options?.connectionString;
    roles = new ModuleRoles({ pool, connectionString: own ?? resolveDatabaseUrl(), masterKey: resolveMasterKey() });
    SHARED.set(pool, roles);
    const shared = roles;
    const end = pool.end.bind(pool);
    pool.end = ((callback?: () => void) => {
      const done = shared.close().then(() => end());
      if (callback === undefined) return done;
      done.then(() => callback(), () => callback());
      return undefined;
    }) as typeof pool.end;
  }
  return roles;
}
