/**
 * How a module's server code reads its own settings. The platform stores and validates them; a module never
 * reaches the database. The platform registers a reader under a global symbol when the web app starts, and
 * `getSetting` asks it. A symbol and not an import, so the SDK stays free of database code and every copy of it
 * that a bundler produces finds the same reader.
 */
export const SETTINGS_READER: unique symbol = Symbol.for("modunexo.settings.reader") as never;

export type SettingValue = string | number | boolean;

export interface SettingsReader {
  get(moduleId: string, key: string): Promise<SettingValue | null>;
}

/** `getSetting` ran where the platform has not registered a reader: a script, a test, a build step. */
export class SettingsUnavailableError extends Error {
  constructor() {
    super("settings can only be read while the platform is serving a request: no settings reader is registered in this process");
    this.name = "SettingsUnavailableError";
  }
}

/**
 * The value of one of the module's declared settings: what was stored, else the declared default, else null.
 * A `secret` comes back decrypted, for server code only; never render it. An unreadable secret throws.
 */
export async function getSetting(moduleId: string, key: string): Promise<SettingValue | null> {
  const reader = (globalThis as typeof globalThis & { [SETTINGS_READER]?: SettingsReader })[SETTINGS_READER];
  if (reader === undefined) throw new SettingsUnavailableError();
  return reader.get(moduleId, key);
}
