import type { SettingDeclaration } from "@epnexo/sdk";

/** What a setting holds once it has been validated. A secret is a string too, and is never shown. */
export type ParsedValue = string | number | boolean;

export type Validation = { ok: true; value: ParsedValue } | { ok: false; message: string };

export const MAX_TEXT_LENGTH = 2000;
export const MAX_PATH_LENGTH = 1024;
export const MAX_SECRET_LENGTH = 4096;

const DECIMAL = /^-?\d+(\.\d+)?$/;

/**
 * Checks one input against the declaration of the setting it is for. The input may be what a form sent (text) or
 * the value itself. The message names the key and the rule and never contains the input, because for a secret the
 * input is the secret.
 */
export function validateSetting(declaration: SettingDeclaration, input: unknown): Validation {
  const refuse = (rule: string): Validation => ({ ok: false, message: `${declaration.key}: ${rule}` });
  const text = typeof input === "string" ? input : undefined;

  switch (declaration.type) {
    case "string": {
      if (text === undefined || text.trim() === "") return refuse("must be some text");
      if (text.includes("\u0000")) return refuse("must not contain a NUL character");
      if (text.length > MAX_TEXT_LENGTH) return refuse(`must be at most ${MAX_TEXT_LENGTH} characters`);
      return { ok: true, value: text };
    }
    case "number": {
      if (typeof input === "number") return Number.isFinite(input) ? { ok: true, value: input } : refuse("must be a finite number");
      if (text === undefined || !DECIMAL.test(text.trim())) return refuse("must be a number in decimal notation");
      const value = Number(text.trim());
      return Number.isFinite(value) ? { ok: true, value } : refuse("must be a finite number");
    }
    case "boolean": {
      if (input === true || input === "true") return { ok: true, value: true };
      if (input === false || input === "false") return { ok: true, value: false };
      return refuse('must be true or false');
    }
    case "select": {
      const options = declaration.options ?? [];
      if (text === undefined || !options.includes(text)) return refuse(`must be one of: ${options.join(", ")}`);
      return { ok: true, value: text };
    }
    case "path": {
      if (text === undefined || text.trim() === "") return refuse("must be an absolute path");
      const path = text.trim();
      if (path.includes("\u0000")) return refuse("must not contain a NUL character");
      if (path.length > MAX_PATH_LENGTH) return refuse(`must be at most ${MAX_PATH_LENGTH} characters`);
      if (!path.startsWith("/")) return refuse("must be an absolute path, starting with /");
      if (path.split("/").includes("..")) return refuse('must not contain ".." segments');
      return { ok: true, value: path };
    }
    case "secret": {
      if (text === undefined || text === "") return refuse("must not be empty");
      if (text.includes("\u0000")) return refuse("must not contain a NUL character");
      if (text.length > MAX_SECRET_LENGTH) return refuse(`must be at most ${MAX_SECRET_LENGTH} characters`);
      return { ok: true, value: text };
    }
  }
}
