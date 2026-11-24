import type { ActionDeclaration, ActionInput } from "@modunexo/sdk";

export type InputResult = { ok: true; values: Record<string, unknown>; ordered: unknown[] } | { ok: false; message: string };

/** A string Postgres or JSON would refuse or change: a NUL, or half of a surrogate pair. */
const UNSTORABLE = /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** One value against its declaration: the value to keep, or the message that says why not. Nothing else about the value is trusted. */
function checkField(name: string, spec: ActionInput, value: unknown): { value: unknown } | { message: string } {
  switch (spec.type) {
    case "text":
      if (typeof value !== "string") return { message: `"${name}" must be text` };
      if (UNSTORABLE.test(value)) return { message: `"${name}" holds a character that cannot be stored` };
      if (value.length > spec.maxLength) return { message: `"${name}" must be at most ${spec.maxLength} characters` };
      return { value };
    case "int":
      if (typeof value !== "number" || !Number.isInteger(value) || value < spec.min || value > spec.max) return { message: `"${name}" must be a whole number from ${spec.min} to ${spec.max}` };
      return { value };
    case "enum":
      if (typeof value !== "string" || !spec.values.includes(value)) return { message: `"${name}" must be one of ${spec.values.join(", ")}` };
      return { value };
    case "boolean":
      if (typeof value !== "boolean") return { message: `"${name}" must be true or false` };
      return { value };
  }
}

/**
 * Checks what a caller sent against the inputs an action declares, before anything runs. Unknown inputs are refused (a prototype
 * key included), a required one must be there, and each value must be of its kind and inside its bounds. `values` holds only what was
 * given; `ordered` follows the declaration, with null where nothing was given, because that is what the statement's `$1`, `$2`
 * mean. The values are never put into the statement's text.
 */
export function checkActionInput(action: ActionDeclaration, raw: unknown): InputResult {
  const declared = action.input ?? {};
  const given = raw === undefined ? {} : raw;
  if (typeof given !== "object" || given === null || Array.isArray(given)) return { ok: false, message: "the input must be an object" };
  const sent = given as Record<string, unknown>;
  for (const key of Object.keys(sent)) {
    if (!Object.hasOwn(declared, key)) return { ok: false, message: `unknown input "${key}"` };
  }
  const values: Record<string, unknown> = {};
  const ordered: unknown[] = [];
  for (const [name, spec] of Object.entries(declared)) {
    const value = sent[name];
    const missing = value === undefined || value === null || (spec.type === "text" && value === "" && spec.required === true);
    if (missing) {
      if (spec.required === true) return { ok: false, message: `"${name}" is required` };
      ordered.push(null);
      continue;
    }
    const checked = checkField(name, spec, value);
    if ("message" in checked) return { ok: false, message: checked.message };
    values[name] = checked.value;
    ordered.push(checked.value);
  }
  return { ok: true, values, ordered };
}
