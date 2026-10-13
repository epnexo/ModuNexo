/** The module or the setting is not one the platform knows. */
export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsError";
  }
}

/** The value was refused by the declaration. The message names the key and the rule, never the value. */
export class SettingValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingValueError";
  }
}
