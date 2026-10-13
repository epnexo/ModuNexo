import { AppearanceService, SettingValueError, validateAppearanceValue } from "@epnexo/core/settings";
import { platform } from "../../../../../../server/platform.ts";
import { enabledModuleIds, webRegistry } from "../../../../../../server/registry.ts";
import { authorizeWrite, json, readJsonBody } from "../../../../../../server/settings-api.ts";

export const dynamic = "force-dynamic";

/** A module's own appearance: { accentHue?: number | null, radius?: string | null }. Null follows the platform again. */
export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const authorized = await authorizeWrite(request);
  if (authorized instanceof Response) return authorized;
  const { id } = await context.params;
  if (webRegistry().get(id) === undefined || id === "core" || !(await enabledModuleIds(platform().pool)).has(id)) return json({ error: `module "${id}" is not enabled` }, 404);

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return json({ error: parsed.message }, 400);
  const body = parsed.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return json({ error: "the request body must be an object" }, 400);
  const keys = Object.keys(body);
  const unknown = keys.filter((key) => key !== "accentHue" && key !== "radius");
  if (unknown.length > 0) return json({ error: `"${unknown[0]}" cannot be overridden per module` }, 400);

  const values = body as Record<"accentHue" | "radius", unknown>;
  const toSet: Record<string, string | number> = {};
  const toClear: ("accentHue" | "radius")[] = [];
  for (const name of ["accentHue", "radius"] as const) {
    if (!(name in values)) continue;
    if (values[name] === null) {
      toClear.push(name);
      continue;
    }
    const checked = validateAppearanceValue(name, values[name]);
    if (!checked.ok) return json({ error: checked.message }, 422);
    toSet[name] = checked.value;
  }

  const service = new AppearanceService(platform().pool, webRegistry());
  try {
    if (Object.keys(toSet).length > 0) await service.setModule(id, toSet, authorized.actor);
    for (const name of toClear) await service.unsetModule(id, name, authorized.actor);
  } catch (error) {
    if (error instanceof SettingValueError) return json({ error: error.message }, 422);
    throw error;
  }
  return json({ override: (await service.get()).modules[id] ?? {} });
}
