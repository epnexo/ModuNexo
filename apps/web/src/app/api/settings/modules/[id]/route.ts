import { resolveMasterKey } from "@modunexo/core/auth";
import { SettingsService, validateSetting } from "@modunexo/core/settings";
import { platform } from "../../../../../server/platform.ts";
import { enabledModuleIds, webRegistry } from "../../../../../server/registry.ts";
import { authorizeWrite, json, readJsonBody } from "../../../../../server/settings-api.ts";
import { planModuleSettingsUpdate } from "../../../../../server/settings-form.ts";

export const dynamic = "force-dynamic";

/**
 * Changes a module's settings: { values: { key: value | null }, clear?: [key] }. Every change is validated before
 * any is written, so a form with one bad field changes nothing; the errors come back by key.
 */
export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const authorized = await authorizeWrite(request);
  if (authorized instanceof Response) return authorized;
  const { id } = await context.params;
  const manifest = webRegistry().get(id);
  if (manifest === undefined || id === "core" || !(await enabledModuleIds(platform().pool)).has(id)) return json({ error: `module "${id}" is not enabled` }, 404);

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return json({ error: parsed.message }, 400);
  const declarations = manifest.settings ?? [];
  const plan = planModuleSettingsUpdate(declarations, parsed.body);
  if (!plan.ok) return json({ error: plan.message }, 400);

  const errors: Record<string, string> = {};
  for (const operation of plan.operations) {
    if (operation.op !== "set") continue;
    const declaration = declarations.find((candidate) => candidate.key === operation.key)!;
    const checked = validateSetting(declaration, operation.value);
    if (!checked.ok) errors[operation.key] = checked.message;
  }
  if (Object.keys(errors).length > 0) return json({ errors }, 422);

  const service = new SettingsService(platform().pool, webRegistry(), { masterKey: resolveMasterKey() });
  await service.applyMany(id, plan.operations, authorized.actor);
  return json({ entries: await service.describe(id) });
}
