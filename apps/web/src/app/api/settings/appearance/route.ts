import { AppearanceService, SettingValueError } from "@modunexo/core/settings";
import { platform } from "../../../../server/platform.ts";
import { webRegistry } from "../../../../server/registry.ts";
import { authorizeWrite, json, readJsonBody } from "../../../../server/settings-api.ts";

export const dynamic = "force-dynamic";

const ALLOWED = ["theme", "accentHue", "radius"];

/** Changes the platform appearance: { theme?, accentHue?, radius? }. One refused value applies none. */
export async function PUT(request: Request) {
  const authorized = await authorizeWrite(request);
  if (authorized instanceof Response) return authorized;
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return json({ error: parsed.message }, 400);
  const body = parsed.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return json({ error: "the request body must be an object" }, 400);
  const unknown = Object.keys(body).filter((key) => !ALLOWED.includes(key));
  if (unknown.length > 0) return json({ error: `unknown appearance setting "${unknown[0]}"` }, 400);

  const service = new AppearanceService(platform().pool, webRegistry());
  try {
    await service.setPlatform(body as Record<string, never>, authorized.actor);
  } catch (error) {
    if (error instanceof SettingValueError) return json({ error: error.message }, 422);
    throw error;
  }
  return json({ appearance: (await service.get()).platform });
}
