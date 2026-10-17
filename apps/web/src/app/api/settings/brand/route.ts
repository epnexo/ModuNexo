import { BrandKindLockedError, BrandService, SettingValueError, readBrand } from "@epnexo/core/settings";
import { platform } from "../../../../server/platform.ts";
import { authorizeWrite, json, readJsonBody } from "../../../../server/settings-api.ts";

export const dynamic = "force-dynamic";

/** Sets the platform identity: { kind: "business", name, representative, email, website?, phone?, taxId?, address? } or { kind: "personal", name, monogramHue? }. The kind cannot change once set (409). */
export async function PUT(request: Request) {
  const authorized = await authorizeWrite(request);
  if (authorized instanceof Response) return authorized;
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return json({ error: parsed.message }, 400);
  const { pool } = platform();
  try {
    await new BrandService(pool).setProfile(parsed.body, authorized.actor);
  } catch (error) {
    if (error instanceof BrandKindLockedError) return json({ error: error.message }, 409);
    if (error instanceof SettingValueError) return json({ error: error.message }, 422);
    throw error;
  }
  return json({ brand: await readBrand(pool) });
}

/** Resets the identity (profile and logo, no CRM data) so the setup runs again: { confirm: "<the current name>" }. */
export async function DELETE(request: Request) {
  const authorized = await authorizeWrite(request);
  if (authorized instanceof Response) return authorized;
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return json({ error: parsed.message }, 400);
  const confirm = typeof parsed.body === "object" && parsed.body !== null ? (parsed.body as { confirm?: unknown }).confirm : undefined;
  const { pool } = platform();
  try {
    await new BrandService(pool).resetIdentity(confirm, authorized.actor);
  } catch (error) {
    if (error instanceof SettingValueError) return json({ error: error.message }, 422);
    throw error;
  }
  return json({ brand: await readBrand(pool) });
}
