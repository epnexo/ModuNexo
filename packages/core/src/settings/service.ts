import type { SettingDeclaration } from "@modunexo/sdk";
import type pg from "pg";
import type { Registry } from "../registry.ts";
import { decryptSecret, encryptSecret } from "./crypto.ts";
import { SettingValueError, SettingsError } from "./errors.ts";
import { type ParsedValue, validateSetting } from "./validate.ts";

export { SettingValueError, SettingsError };

export interface SettingEntry {
  key: string;
  label: string;
  type: SettingDeclaration["type"];
  description?: string;
  required: boolean;
  options?: string[];
  default?: string | number | boolean;
  /** What a reader gets: stored, else default, else null. Always null for a secret. */
  effective: ParsedValue | null;
  source: "stored" | "default" | "unset";
  /** Only for a secret: whether one is stored and whether it can still be decrypted. The value is never here. */
  secret?: { set: boolean; unreadable: boolean };
  /** Required, and nothing usable is set or declared as a default. */
  incomplete: boolean;
  /** A value is stored but the declaration no longer accepts it, so the default applies. */
  invalid: boolean;
}

export type SettingOperation = { op: "set"; key: string; value: unknown } | { op: "unset"; key: string };

export interface SettingsServiceOptions {
  /** `MODUNEXO_MASTER_KEY`. Secrets are encrypted under a key derived from it. */
  masterKey: string;
}

interface Row {
  key: string;
  value: unknown;
  secret: string | null;
}

/**
 * The values of the settings modules declare. The declarations come from the manifests in the registry, so only a
 * declared key can be read or written, and every write is checked against its declaration, stored with who made it
 * and recorded in an audit trail that holds no values.
 */
export class SettingsService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly registry: Registry,
    private readonly options: SettingsServiceOptions,
  ) {}

  private declarations(moduleId: string): SettingDeclaration[] {
    const manifest = this.registry.get(moduleId);
    if (manifest === undefined) throw new SettingsError(`module "${moduleId}" is not registered`);
    return manifest.settings ?? [];
  }

  private declaration(moduleId: string, key: string): SettingDeclaration {
    const found = this.declarations(moduleId).find((d) => d.key === key);
    if (found === undefined) throw new SettingsError(`module "${moduleId}" does not declare a setting "${key}"`);
    return found;
  }

  private async rows(moduleId: string): Promise<Map<string, Row>> {
    const { rows } = await this.pool.query("select key, value, secret from core.module_settings where module_id = $1", [moduleId]);
    return new Map((rows as Row[]).map((row) => [row.key, row]));
  }

  private entryFor(moduleId: string, declaration: SettingDeclaration, row: Row | undefined): SettingEntry {
    const base = {
      key: declaration.key,
      label: declaration.label,
      type: declaration.type,
      required: declaration.required === true,
      ...(declaration.description === undefined ? {} : { description: declaration.description }),
      ...(declaration.options === undefined ? {} : { options: declaration.options }),
      ...(declaration.default === undefined ? {} : { default: declaration.default }),
    };
    if (declaration.type === "secret") {
      const set = row?.secret != null;
      let unreadable = false;
      if (set) {
        try {
          decryptSecret(this.options.masterKey, { moduleId, key: declaration.key }, row!.secret!);
        } catch {
          unreadable = true;
        }
      }
      return { ...base, effective: null, source: set ? "stored" : "unset", secret: { set, unreadable }, incomplete: base.required && (!set || unreadable), invalid: false };
    }
    const stored = row?.value;
    const usable = stored !== undefined && stored !== null && validateSetting(declaration, stored).ok;
    if (usable) return { ...base, effective: stored as ParsedValue, source: "stored", incomplete: false, invalid: false };
    const fallback = declaration.default ?? null;
    return {
      ...base,
      effective: fallback,
      source: fallback === null ? "unset" : "default",
      incomplete: base.required && fallback === null,
      invalid: stored !== undefined && stored !== null,
    };
  }

  /** Every declared setting of the module, in declaration order, with where its effective value comes from. */
  async describe(moduleId: string): Promise<SettingEntry[]> {
    const declarations = this.declarations(moduleId);
    if (declarations.length === 0) return [];
    const rows = await this.rows(moduleId);
    return declarations.map((declaration) => this.entryFor(moduleId, declaration, rows.get(declaration.key)));
  }

  /**
   * The value module server code uses: stored, else default, else null. A secret is decrypted here and nowhere
   * else; one that cannot be decrypted throws `SecretUnreadableError` so the caller can say so.
   */
  async get(moduleId: string, key: string): Promise<ParsedValue | null> {
    const declaration = this.declaration(moduleId, key);
    const { rows } = await this.pool.query("select key, value, secret from core.module_settings where module_id = $1 and key = $2", [moduleId, key]);
    const row = rows[0] as Row | undefined;
    if (declaration.type === "secret") {
      if (row?.secret == null) return null;
      return decryptSecret(this.options.masterKey, { moduleId, key }, row.secret);
    }
    return this.entryFor(moduleId, declaration, row).effective;
  }

  /** Validates and stores a value. A refused value changes nothing and leaves no audit row. */
  async set(moduleId: string, key: string, input: unknown, actor: string): Promise<void> {
    await this.applyMany(moduleId, [{ op: "set", key, value: input }], actor);
  }

  /** Removes the stored value so the default applies again. Nothing stored means nothing happens and nothing is logged. */
  async unset(moduleId: string, key: string, actor: string): Promise<void> {
    await this.applyMany(moduleId, [{ op: "unset", key }], actor);
  }

  /**
   * Applies several changes as one: every key is checked against its declaration and every value is validated and
   * encrypted before the database is touched, then all of it is written in one transaction. A refused value, an
   * undeclared key or a database error leaves every setting as it was and writes no audit row. An unset of
   * something that was not stored is silent.
   */
  async applyMany(moduleId: string, operations: readonly SettingOperation[], actor: string): Promise<void> {
    if (operations.length === 0) return;
    const prepared = operations.map((operation) => {
      const declaration = this.declaration(moduleId, operation.key);
      if (operation.op === "unset") return { op: "unset" as const, key: operation.key };
      const checked = validateSetting(declaration, operation.value);
      if (!checked.ok) throw new SettingValueError(checked.message);
      const isSecret = declaration.type === "secret";
      return {
        op: "set" as const,
        key: operation.key,
        value: isSecret ? null : JSON.stringify(checked.value),
        secret: isSecret ? encryptSecret(this.options.masterKey, { moduleId, key: operation.key }, String(checked.value)) : null,
      };
    });

    const client = await this.pool.connect();
    try {
      await client.query("begin");
      for (const step of prepared) {
        if (step.op === "set") {
          await client.query(
            `insert into core.module_settings (module_id, key, value, secret, updated_by) values ($1, $2, $3::jsonb, $4, $5)
             on conflict (module_id, key) do update set value = excluded.value, secret = excluded.secret, updated_at = now(), updated_by = excluded.updated_by`,
            [moduleId, step.key, step.value, step.secret, actor],
          );
          await client.query("insert into core.settings_events (scope, key, action, actor) values ($1, $2, 'set', $3)", [moduleId, step.key, actor]);
        } else {
          const removed = await client.query("delete from core.module_settings where module_id = $1 and key = $2", [moduleId, step.key]);
          if ((removed.rowCount ?? 0) > 0) {
            await client.query("insert into core.settings_events (scope, key, action, actor) values ($1, $2, 'unset', $3)", [moduleId, step.key, actor]);
          }
        }
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Keys of required settings that have no usable value and no default. */
  async incomplete(moduleId: string): Promise<string[]> {
    return (await this.describe(moduleId)).filter((entry) => entry.incomplete).map((entry) => entry.key);
  }
}

