import { BrandService, SettingValueError, readBrand } from "@epnexo/core/settings";
import { platform } from "../../../../server/platform.ts";
import { authorizeWrite, json, readJsonBody } from "../../../../server/settings-api.ts";

export const dynamic = "force-dynamic";

/** Sets the platform identity: { kind: "business", name, representative, email, website?, phone?, taxId?, address? } or { kind: "personal", name, monogramHue? }. */
export async function PUT(request: Request) {
  const authorized = await authorizeWrite(request);
  if (authorized instanceof Response) return authorized;
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return json({ error: parsed.message }, 400);
  const { pool } = platform();
  try {
    await new BrandService(pool).setProfile(parsed.body, authorized.actor);
  } catch (error) {
    if (error instanceof SettingValueError) return json({ error: error.message }, 422);
    throw error;
  }
  return json({ brand: await readBrand(pool) });
}

/** Removes the identity (and the logo) so the shell goes back to its default name. */
export async function DELETE(request: Request) {
  const authorized = await authorizeWrite(request);
  if (authorized instanceof Response) return authorized;
  const { pool } = platform();
  const service = new BrandService(pool);
  await service.clearProfile(authorized.actor);
  await service.clearLogo(authorized.actor);
  return json({ brand: await readBrand(pool) });
}
