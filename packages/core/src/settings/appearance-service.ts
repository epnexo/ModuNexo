import type pg from "pg";
import { CORE_MODULE_ID } from "../core-module.ts";
import type { Registry } from "../registry.ts";
import {
  APPEARANCE_NAMES,
  type Appearance,
  type AppearanceName,
  type AppearanceState,
  MODULE_APPEARANCE_NAMES,
  type ModuleAppearance,
  type ModuleAppearanceName,
  moduleKey,
  modulePrefix,
  platformKey,
  resolveAppearance,
  validateAppearanceValue,
} from "./appearance.ts";
import { sanitizeCustomCss } from "./custom-css.ts";
import { SettingValueError, SettingsError } from "./service.ts";

/** The stored appearance, for a reader that only needs to render it (no registry, no writes). */
export async function readAppearance(pool: pg.Pool): Promise<AppearanceState> {
  const { rows } = await pool.query("select key, value from core.platform_settings where starts_with(key, 'appearance.')");
  return resolveAppearance(rows as { key: string; value: unknown }[]);
}

/** The `core.platform_settings` key of the company's custom CSS: the text its administrator wrote. Not under `appearance.`, so the appearance reads never carry it. */
export const CUSTOM_CSS_KEY = "custom-css.company";
/** The key a person's custom CSS is logged under in `core.settings_events`; the text lives in `core.user_custom_css`. */
export const USER_CSS_KEY = "custom-css.person";

/** The text of the company's custom CSS as it was written, or "" when there is none. */
export async function readCustomCss(pool: pg.Pool): Promise<string> {
  const { rows } = await pool.query("select value from core.platform_settings where key = $1", [CUSTOM_CSS_KEY]);
  const value = (rows[0] as { value: unknown } | undefined)?.value;
  return typeof value === "string" ? value : "";
}

/**
 * What a page may serve: the stylesheet parsed and written again from the rules that pass, or nothing. It is checked on
 * every read, not only on write, so a value put in the database by hand never reaches a page as text.
 */
export async function readServedCustomCss(pool: pg.Pool): Promise<string> {
  return servedCustomCss(await readCustomCss(pool));
}

// The text and what it was rewritten to, from the last time. A page reads the stylesheet on every request and the text almost never
// changes, so the check (12 to 28 ms for a 16 KB stylesheet on a Raspberry Pi) is paid once per change instead of once per page.
let lastServed: { text: string; css: string } | undefined;

/** What a page may serve for this text: the stylesheet rewritten from the rules that pass, or nothing. */
export function servedCustomCss(text: string): string {
  if (text.trim() === "") return "";
  if (lastServed?.text === text) return lastServed.css;
  const checked = sanitizeCustomCss(text);
  const css = checked.ok ? checked.css : "";
  lastServed = { text, css };
  return css;
}

/** The text of one person's own custom CSS as they wrote it, or "" when there is none. */
export async function readUserCss(pool: pg.Pool, userId: string): Promise<string> {
  const { rows } = await pool.query("select css from core.user_custom_css where user_id = $1", [userId]);
  return (rows[0] as { css: string } | undefined)?.css ?? "";
}

// A page serves one person's stylesheet on every request, so the last results are kept by text: the check is paid once per change.
const servedByUser = new Map<string, { text: string; css: string }>();
const MAX_REMEMBERED_USERS = 64;

/** What a page may serve for this person: their stylesheet rewritten from the rules that pass, or nothing. `null` is nobody (the local operator, the sign-in page). */
export async function readServedUserCss(pool: pg.Pool, userId: string | null): Promise<string> {
  if (userId === null) return "";
  const text = await readUserCss(pool, userId);
  if (text.trim() === "") return "";
  const known = servedByUser.get(userId);
  if (known?.text === text) return known.css;
  const checked = sanitizeCustomCss(text, "person");
  const css = checked.ok ? checked.css : "";
  if (servedByUser.size >= MAX_REMEMBERED_USERS) servedByUser.delete(servedByUser.keys().next().value as string);
  servedByUser.set(userId, { text, css });
  return css;
}

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
    return readAppearance(this.pool);
  }

  /** The company's custom CSS as it was written, for the editor. */
  async customCss(): Promise<string> {
    return readCustomCss(this.pool);
  }

  /**
   * Checks the stylesheet and stores it as written. Anything refused stores nothing and says every line it is on; blank text
   * clears it. Only the fact that it changed is logged, never the text.
   */
  async setCustomCss(text: string, actor: string): Promise<void> {
    if (text.trim() === "") return this.clearCustomCss(actor);
    const checked = sanitizeCustomCss(text);
    if (!checked.ok) throw new SettingValueError(checked.errors.map((error) => `line ${error.line}: ${error.message}`).join("\n"));
    await this.write("platform", [{ key: CUSTOM_CSS_KEY, value: text }], actor);
  }

  /** One person's own custom CSS as they wrote it, for their editor. */
  async userCss(userId: string): Promise<string> {
    return readUserCss(this.pool, userId);
  }

  /** Checks a person's stylesheet with the same rules as the company's and stores it as written; blank text clears it. The text is never logged. */
  async setUserCss(userId: string, text: string, actor: string): Promise<void> {
    if (text.trim() === "") return this.clearUserCss(userId, actor);
    const checked = sanitizeCustomCss(text, "person");
    if (!checked.ok) throw new SettingValueError(checked.errors.map((error) => `line ${error.line}: ${error.message}`).join("\n"));
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `insert into core.user_custom_css (user_id, css) values ($1, $2)
         on conflict (user_id) do update set css = excluded.css, updated_at = now()`,
        [userId, text],
      );
      await client.query("insert into core.settings_events (scope, key, action, actor) values ($1, $2, 'set', $3)", [`user:${userId}`, USER_CSS_KEY, actor]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Removes a person's custom CSS. Nothing stored means nothing happens and nothing is logged. */
  async clearUserCss(userId: string, actor: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const removed = await client.query("delete from core.user_custom_css where user_id = $1", [userId]);
      if ((removed.rowCount ?? 0) > 0) {
        await client.query("insert into core.settings_events (scope, key, action, actor) values ($1, $2, 'unset', $3)", [`user:${userId}`, USER_CSS_KEY, actor]);
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Removes the company's custom CSS. Nothing stored means nothing happens and nothing is logged. */
  async clearCustomCss(actor: string): Promise<void> {
    await this.remove("platform", CUSTOM_CSS_KEY, actor);
  }

  /** Removes one stored platform value so its default applies again. Nothing stored means nothing is logged. */
  async unsetPlatform(name: AppearanceName, actor: string): Promise<void> {
    await this.remove("platform", platformKey(name), actor);
  }

  /** Removes one of a module's overrides so that value follows the platform again. */
  async unsetModule(moduleId: string, name: ModuleAppearanceName, actor: string): Promise<void> {
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
    for (const name of MODULE_APPEARANCE_NAMES) {
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
