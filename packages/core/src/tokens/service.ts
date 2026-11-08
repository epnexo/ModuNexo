import { timingSafeEqual } from "node:crypto";
import type pg from "pg";
import type { Registry } from "../registry.ts";
import { TokenError } from "./errors.ts";
import { generateToken, hashToken, tokenPrefix } from "./format.ts";

/** A token as the platform lists it. The token itself and its hash never leave the service. */
export interface TokenRecord {
  id: number;
  moduleId: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdBy: string;
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
}

export interface CreateTokenInput {
  moduleId: string;
  name: string;
  scopes: string[];
  expiresAt?: Date;
  actor: string;
}

/** Why a token was refused. The caller of a route is told only 401 or 403; the log gets the reason. */
export type TokenRefusal = "malformed" | "unknown" | "revoked" | "expired" | "wrong_module" | "forbidden_scope";
export type VerifyResult = { ok: true; tokenId: number } | { ok: false; reason: TokenRefusal };

export interface TokenServiceOptions {
  now?: () => Date;
  random?: (size: number) => Buffer;
}

const MAX_NAME = 80;
const PREFIX_ATTEMPTS = 5;
/** `last_used_at` is a hint for the operator, not a counter, so a busy token does not write on every request. */
const LAST_USED_RESOLUTION_MS = 60_000;
const UNIQUE_VIOLATION = "23505";

const ROW = `id, module_id, name, prefix, scopes, created_by, created_at, expires_at, revoked_at, last_used_at`;

function toRecord(row: Record<string, unknown>): TokenRecord {
  return {
    id: Number(row.id),
    moduleId: row.module_id as string,
    name: row.name as string,
    prefix: row.prefix as string,
    scopes: row.scopes as string[],
    createdBy: row.created_by as string,
    createdAt: row.created_at as Date,
    expiresAt: (row.expires_at as Date | null) ?? null,
    revokedAt: (row.revoked_at as Date | null) ?? null,
    lastUsedAt: (row.last_used_at as Date | null) ?? null,
  };
}

/** Where a token stands at `now`: revoked wins over expired. */
export function tokenState(record: TokenRecord, now: Date): "active" | "revoked" | "expired" {
  if (record.revokedAt !== null) return "revoked";
  if (record.expiresAt !== null && record.expiresAt.getTime() <= now.getTime()) return "expired";
  return "active";
}

/** Service tokens: issued per module for a subset of the scopes the module declares, revoked at will. */
export class TokenService {
  private readonly now: () => Date;
  private readonly random: ((size: number) => Buffer) | undefined;

  constructor(
    private readonly pool: pg.Pool,
    private readonly registry: Registry,
    options: TokenServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.random = options.random;
  }

  /** Issues a token. The returned text is the only copy there will ever be. */
  async create(input: CreateTokenInput): Promise<{ record: TokenRecord; token: string }> {
    const manifest = this.registry.get(input.moduleId);
    if (manifest === undefined) throw new TokenError(`module "${input.moduleId}" is not registered`);
    const name = input.name.trim();
    if (name === "" || name.length > MAX_NAME || /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(name)) {
      throw new TokenError(`the token name must be 1 to ${MAX_NAME} characters with no control or invisible formatting characters`);
    }
    const declared = new Set((manifest.scopes ?? []).map((scope) => scope.key));
    const scopes = [...new Set(input.scopes)].sort();
    if (scopes.length === 0) throw new TokenError("a token needs at least one scope");
    for (const scope of scopes) {
      if (!declared.has(scope)) {
        throw new TokenError(`module "${input.moduleId}" does not declare the scope "${scope}"${declared.size === 0 ? " (it declares none)" : ` (declared: ${[...declared].sort().join(", ")})`}`);
      }
    }
    if (input.expiresAt !== undefined && !(input.expiresAt.getTime() > this.now().getTime())) {
      throw new TokenError("the expiry must be in the future");
    }

    return this.issue(async (client, generated) => {
      const record = await this.insert(client, generated, { moduleId: input.moduleId, name, scopes, expiresAt: input.expiresAt ?? null, actor: input.actor });
      return { record, token: generated.token };
    });
  }

  /**
   * Replaces a token: a new one with the same name, scopes and length of life, and the old one revoked, in one
   * transaction, so the old token never stays valid beside its replacement and a failure leaves it untouched.
   * A token that was already revoked is not renewed; issue a new one instead.
   */
  async regenerate(id: number, actor: string): Promise<{ record: TokenRecord; token: string; revoked: TokenRecord }> {
    return this.issue(async (client, generated) => {
      const found = await client.query(`select ${ROW} from core.service_tokens where id = $1 for update`, [id]);
      if (found.rowCount === 0) throw new TokenError(`there is no token ${id}`, "not-found");
      const old = toRecord(found.rows[0]);
      if (old.revokedAt !== null) throw new TokenError(`token ${id} is already revoked; issue a new one`, "revoked");
      const manifest = this.registry.get(old.moduleId);
      if (manifest === undefined) throw new TokenError(`module "${old.moduleId}" is not registered`);
      const declared = new Set((manifest.scopes ?? []).map((scope) => scope.key));
      for (const scope of old.scopes) {
        if (!declared.has(scope)) throw new TokenError(`module "${old.moduleId}" does not declare the scope "${scope}" any more`);
      }
      const now = this.now();
      const life = old.expiresAt === null ? null : old.expiresAt.getTime() - old.createdAt.getTime();
      const expiresAt = life === null ? null : new Date(now.getTime() + life);
      const record = await this.insert(client, generated, { moduleId: old.moduleId, name: old.name, scopes: old.scopes, expiresAt, actor });
      const updated = await client.query(`update core.service_tokens set revoked_at = $2 where id = $1 returning ${ROW}`, [id, now]);
      const revoked = toRecord(updated.rows[0]);
      await client.query("insert into core.service_token_events (token_id, module_id, action, actor) values ($1, $2, 'revoked', $3)", [id, old.moduleId, actor]);
      return { record, token: generated.token, revoked };
    });
  }

  /** Runs `work` in a transaction with a freshly drawn token, drawing again when two tokens share the 32-bit prefix. */
  private async issue<T>(work: (client: pg.PoolClient, generated: ReturnType<typeof generateToken>) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < PREFIX_ATTEMPTS; attempt++) {
      const generated = generateToken(this.random);
      const client = await this.pool.connect();
      try {
        await client.query("begin");
        const result = await work(client, generated);
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        if ((error as { code?: string }).code === UNIQUE_VIOLATION) continue;
        throw error;
      } finally {
        client.release();
      }
    }
    throw new TokenError("could not find a free token prefix; try again");
  }

  private async insert(
    client: pg.PoolClient,
    generated: ReturnType<typeof generateToken>,
    row: { moduleId: string; name: string; scopes: string[]; expiresAt: Date | null; actor: string },
  ): Promise<TokenRecord> {
    const inserted = await client.query(
      `insert into core.service_tokens (module_id, name, prefix, token_hash, scopes, expires_at, created_by)
       values ($1, $2, $3, $4, $5, $6, $7) returning ${ROW}`,
      [row.moduleId, row.name, generated.prefix, generated.hash, row.scopes, row.expiresAt, row.actor],
    );
    const record = toRecord(inserted.rows[0]);
    await client.query("insert into core.service_token_events (token_id, module_id, action, actor) values ($1, $2, 'created', $3)", [record.id, record.moduleId, row.actor]);
    return record;
  }

  async list(moduleId?: string): Promise<TokenRecord[]> {
    const result =
      moduleId === undefined
        ? await this.pool.query(`select ${ROW} from core.service_tokens order by id`)
        : await this.pool.query(`select ${ROW} from core.service_tokens where module_id = $1 order by id`, [moduleId]);
    return result.rows.map(toRecord);
  }

  /** One token by id, or null. Never the token's value, which is not kept. */
  async find(id: number): Promise<TokenRecord | null> {
    const result = await this.pool.query(`select ${ROW} from core.service_tokens where id = $1`, [id]);
    return result.rowCount === 0 ? null : toRecord(result.rows[0]);
  }

  /** Revokes a token. Revoking one that is already revoked changes nothing and records nothing. */
  async revoke(id: number, actor: string): Promise<TokenRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const found = await client.query(`select ${ROW} from core.service_tokens where id = $1 for update`, [id]);
      if (found.rowCount === 0) {
        await client.query("rollback");
        throw new TokenError(`there is no token ${id}`, "not-found");
      }
      let record = toRecord(found.rows[0]);
      if (record.revokedAt === null) {
        const updated = await client.query(`update core.service_tokens set revoked_at = $2 where id = $1 returning ${ROW}`, [id, this.now()]);
        record = toRecord(updated.rows[0]);
        await client.query("insert into core.service_token_events (token_id, module_id, action, actor) values ($1, $2, 'revoked', $3)", [id, record.moduleId, actor]);
      }
      await client.query("commit");
      return record;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Does this token belong to `moduleId` and hold `scope`, and is it still good? Never throws for a bad token. */
  async verify(token: string, need: { moduleId: string; scope: string }): Promise<VerifyResult> {
    const prefix = tokenPrefix(token);
    if (prefix === null) return { ok: false, reason: "malformed" };
    const found = await this.pool.query("select id, module_id, token_hash, scopes, expires_at, revoked_at, last_used_at from core.service_tokens where prefix = $1", [prefix]);
    if (found.rowCount === 0) return { ok: false, reason: "unknown" };
    const row = found.rows[0];
    const stored = Buffer.from(row.token_hash as string, "hex");
    const sent = Buffer.from(hashToken(token), "hex");
    if (stored.length !== sent.length || !timingSafeEqual(stored, sent)) return { ok: false, reason: "unknown" };

    const now = this.now();
    if (row.revoked_at !== null) return { ok: false, reason: "revoked" };
    if (row.expires_at !== null && (row.expires_at as Date).getTime() <= now.getTime()) return { ok: false, reason: "expired" };
    if (row.module_id !== need.moduleId) return { ok: false, reason: "wrong_module" };
    if (!(row.scopes as string[]).includes(need.scope)) return { ok: false, reason: "forbidden_scope" };

    const id = Number(row.id);
    const last = row.last_used_at as Date | null;
    if (last === null || now.getTime() - last.getTime() >= LAST_USED_RESOLUTION_MS) {
      // A failed write must not turn a good token away.
      await this.pool.query("update core.service_tokens set last_used_at = $2 where id = $1", [id, now]).catch(() => undefined);
    }
    return { ok: true, tokenId: id };
  }
}
