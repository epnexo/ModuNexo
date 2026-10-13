import type { SettingDeclaration } from "@epnexo/sdk";

export type FormOperation = { op: "set"; key: string; value: string | number | boolean } | { op: "unset"; key: string };

export type FormPlan = { ok: true; operations: FormOperation[] } | { ok: false; message: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Turns the body of the settings form into the operations to apply, without touching the database.
 *
 * A field that is absent is left alone. An empty or null value clears a plain setting so its default applies
 * again. A secret that was left blank is kept, because a secret is never sent back to the form to be re-entered;
 * it is replaced by typing a new one and removed only by naming it in `clear`, which wins over a typed value.
 * Messages name keys and never repeat a value.
 */
export function planModuleSettingsUpdate(declarations: readonly SettingDeclaration[], body: unknown): FormPlan {
  if (!isRecord(body) || !isRecord(body.values)) return { ok: false, message: 'the request body must be { "values": { ... }, "clear": [ ... ] }' };
  const byKey = new Map(declarations.map((declaration) => [declaration.key, declaration]));
  const operations: FormOperation[] = [];

  for (const [key, value] of Object.entries(body.values)) {
    const declaration = byKey.get(key);
    if (declaration === undefined) return { ok: false, message: `"${key}" is not a setting of this module` };
    if (value !== null && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      return { ok: false, message: `${key}: the value must be text, a number, a boolean or null` };
    }
    if (declaration.type === "secret") {
      if (value === null || value === "") continue;
      if (typeof value !== "string") return { ok: false, message: `${key}: a secret must be text` };
      operations.push({ op: "set", key, value });
      continue;
    }
    if (value === null || value === "") operations.push({ op: "unset", key });
    else operations.push({ op: "set", key, value });
  }

  if (body.clear !== undefined) {
    if (!Array.isArray(body.clear) || !body.clear.every((item) => typeof item === "string")) return { ok: false, message: '"clear" must be a list of setting keys' };
    for (const key of body.clear as string[]) {
      if (!byKey.has(key)) return { ok: false, message: `"${key}" is not a setting of this module` };
      const existing = operations.findIndex((operation) => operation.key === key);
      if (existing !== -1) operations.splice(existing, 1);
      operations.push({ op: "unset", key });
    }
  }
  return { ok: true, operations };
}

/**
 * The body of a module's appearance form. What was typed travels as text and the server validates it; an empty
 * field means "follow the platform" and is the only thing sent as null. Converting the hue to a number here would
 * turn unparseable text into NaN, which JSON writes as null, and silently clear the override that was stored.
 */
export function moduleAppearanceBody(hue: string, radius: string): { accentHue: string | null; radius: string | null } {
  const typed = hue.trim();
  return { accentHue: typed === "" ? null : typed, radius: radius === "" ? null : radius };
}
