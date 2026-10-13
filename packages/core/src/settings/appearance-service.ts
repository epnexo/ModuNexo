import type pg from "pg";
import { CORE_MODULE_ID } from "../core-module.ts";
import type { Registry } from "../registry.ts";
import {
  APPEARANCE_NAMES,
  type Appearance,
  type AppearanceName,
  type AppearanceState,
  type ModuleAppearance,
  moduleKey,
  modulePrefix,
  platformKey,
  resolveAppearance,
  validateAppearanceValue,
} from "./appearance.ts";
import { SettingValueError, SettingsError } from "./service.ts";

/** Reads and writes the platform appearance and the per-module overrides, in `core.platform_settings`. */
export class AppearanceService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly registry: Registry,
  ) {}

  /** The raw stored rows, so a caller can tell a stored value from a default. */
  async stored(): Promise<{ key: string; value: unknown }[]> {
    const { rows } = await this.pool.query("select key, value from core.platform_settings where starts_with(key, 'appearance.')");
    return rows as { key: string; value: unknown }[];
  }

  async get(): Promise<AppearanceState> {
    return resolveAppearance(await this.stored());
  }

  /** Removes one stored platform value so its default applies again. Nothing stored means nothing is logged. */
  async unsetPlatform(name: AppearanceName, actor: string): Promise<void> {
    await this.remove("platform", platformKey(name), actor);
  }

  /** Removes one of a module's overrides so that value follows the platform again. */
  async unsetModule(moduleId: string, name: "accentHue" | "radius", actor: string): Promise<void> {
    this.knownModule(moduleId);
    await this.remove(moduleId, moduleKey(moduleId, name), actor);
  }

  private async remove(scope: string, key: string, actor: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const removed = await client.query("delete from core.platform_settings where key = $1", [key]);
      if ((removed.rowCount ?? 0) > 0) {
        await client.query("insert into core.settings_events (scope, key, action, actor) values ($1, $2, 'unset', $3)", [scope, key, actor]);
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Validates every value first, then writes them together; one refused value applies none. */
  async setPlatform(values: Partial<Appearance>, actor: string): Promise<void> {
    const writes: { key: string; value: string | number }[] = [];
    for (const name of APPEARANCE_NAMES) {
      if (values[name] === undefined) continue;
      const checked = validateAppearanceValue(name, values[name]);
      if (!checked.ok) throw new SettingValueError(checked.message);
      writes.push({ key: platformKey(name), value: checked.value });
    }
    await this.write("platform", writes, actor);
  }

  async setModule(moduleId: string, values: ModuleAppearance, actor: string): Promise<void> {
    this.knownModule(moduleId);
    const writes: { key: string; value: string | number }[] = [];
    for (const name of ["accentHue", "radius"] as const) {
      if (values[name] === undefined) continue;
      const checked = validateAppearanceValue(name, values[name]);
      if (!checked.ok) throw new SettingValueError(checked.message);
      writes.push({ key: moduleKey(moduleId, name), value: checked.value });
    }
    await this.write(moduleId, writes, actor);
  }

  /** Removes a module's overrides so it follows the platform again. With none stored nothing happens. */
  async clearModule(moduleId: string, actor: string): Promise<void> {
    this.knownModule(moduleId);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const removed = await client.query("delete from core.platform_settings where starts_with(key, $1) returning key", [modulePrefix(moduleId)]);
      for (const row of removed.rows as { key: string }[]) {
        await client.query("insert into core.settings_events (scope, key, action, actor) values ($1, $2, 'unset', $3)", [moduleId, row.key, actor]);
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private knownModule(moduleId: string): void {
    if (moduleId === CORE_MODULE_ID || this.registry.get(moduleId) === undefined) throw new SettingsError(`module "${moduleId}" is not registered`);
  }

  private async write(scope: string, writes: { key: string; value: string | number }[], actor: string): Promise<void> {
    if (writes.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      for (const { key, value } of writes) {
        await client.query(
          `insert into core.platform_settings (key, value, updated_by) values ($1, $2::jsonb, $3)
           on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by`,
          [key, JSON.stringify(value), actor],
        );
        await client.query("insert into core.settings_events (scope, key, action, actor) values ($1, $2, 'set', $3)", [scope, key, actor]);
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
