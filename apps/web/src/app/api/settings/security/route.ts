import { setTrustedProxies } from "@modunexo/core/auth";
import { SettingValueError } from "@modunexo/core/settings";
import { platform } from "../../../../server/platform.ts";
import { authorizeWrite, json, readJsonBody } from "../../../../server/settings-api.ts";

export const dynamic = "force-dynamic";

/**
 * Changes the platform security settings: { trustedProxies: string | string[] }. An empty list trusts nobody, which
 * is the default. The list is validated as a whole and a refusal changes nothing.
 */
export async function PUT(request: Request) {
  const authorized = await authorizeWrite(request);
  if (authorized instanceof Response) return authorized;
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return json({ error: parsed.message }, 400);
  const body = parsed.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return json({ error: "the request body must be an object" }, 400);
  const unknown = Object.keys(body).filter((key) => key !== "trustedProxies");
  if (unknown.length > 0) return json({ error: `unknown security setting "${unknown[0]}"` }, 400);
  if (!("trustedProxies" in body)) return json({ error: "nothing to change: send { trustedProxies }" }, 400);

  try {
    const trustedProxies = await setTrustedProxies(platform().pool, (body as { trustedProxies: unknown }).trustedProxies, authorized.actor);
    return json({ trustedProxies });
  } catch (error) {
    if (error instanceof SettingValueError) return json({ error: error.message }, 422);
    throw error;
  }
}
