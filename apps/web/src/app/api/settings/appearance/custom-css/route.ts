import { AppearanceService, SettingValueError } from "@modunexo/core/settings";
import { platform } from "../../../../../server/platform.ts";
import { webRegistry } from "../../../../../server/registry.ts";
import { authorizeWrite, json, readJsonBody } from "../../../../../server/settings-api.ts";

export const dynamic = "force-dynamic";

/**
 * The company's custom CSS: { css: string }. The text is checked as a whole: anything not allowed refuses it all with the
 * line of each problem (422), and blank text removes it. Only an administrator, from this site, can write it.
 */
export async function PUT(request: Request) {
  const authorized = await authorizeWrite(request);
  if (authorized instanceof Response) return authorized;
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return json({ error: parsed.message }, 400);
  const body = parsed.body;
  if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).some((key) => key !== "css")) return json({ error: 'the request body must be { "css": "<text>" }' }, 400);
  const css = (body as { css?: unknown }).css;
  if (typeof css !== "string") return json({ error: '"css" must be text' }, 400);

  const service = new AppearanceService(platform().pool, webRegistry());
  try {
    await service.setCustomCss(css, authorized.actor);
  } catch (error) {
    if (error instanceof SettingValueError) return json({ error: error.message }, 422);
    throw error;
  }
  return json({ css: await service.customCss() });
}

/** Removes the company's custom CSS so the platform's own look applies again. */
export async function DELETE(request: Request) {
  const authorized = await authorizeWrite(request);
  if (authorized instanceof Response) return authorized;
  await new AppearanceService(platform().pool, webRegistry()).clearCustomCss(authorized.actor);
  return json({ css: "" });
}
