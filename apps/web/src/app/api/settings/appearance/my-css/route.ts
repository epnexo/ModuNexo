import { AppearanceService, SettingValueError } from "@modunexo/core/settings";
import { platform } from "../../../../../server/platform.ts";
import { webRegistry } from "../../../../../server/registry.ts";
import { authorizeSelf, json, readJsonBody } from "../../../../../server/settings-api.ts";

export const dynamic = "force-dynamic";

/**
 * The signed-in person's own custom CSS: { css: string }. The same checks as the company's, applied to the whole text: anything not
 * allowed refuses it all with the line of each problem (422), and blank text removes it. It is only ever theirs: the person is the
 * one in the session, never a value in the request, and it shows only to them.
 */
export async function PUT(request: Request) {
  const authorized = await authorizeSelf(request);
  if (authorized instanceof Response) return authorized;
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return json({ error: parsed.message }, 400);
  const body = parsed.body;
  if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).some((key) => key !== "css")) return json({ error: 'the request body must be { "css": "<text>" }' }, 400);
  const css = (body as { css?: unknown }).css;
  if (typeof css !== "string") return json({ error: '"css" must be text' }, 400);

  const service = new AppearanceService(platform().pool, webRegistry());
  try {
    await service.setUserCss(authorized.userId, css, authorized.actor);
  } catch (error) {
    if (error instanceof SettingValueError) return json({ error: error.message }, 422);
    throw error;
  }
  return json({ css: await service.userCss(authorized.userId) });
}

/** Removes the signed-in person's custom CSS. */
export async function DELETE(request: Request) {
  const authorized = await authorizeSelf(request);
  if (authorized instanceof Response) return authorized;
  await new AppearanceService(platform().pool, webRegistry()).clearUserCss(authorized.userId, authorized.actor);
  return json({ css: "" });
}
