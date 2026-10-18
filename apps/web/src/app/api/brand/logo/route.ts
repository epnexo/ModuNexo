import { BrandService, MAX_IMAGE_BYTES, SettingValueError, readBrand, readLogo } from "@modunexo/core/settings";
import { platform } from "../../../../server/platform.ts";
import { authorizeWrite, json, readBodyBytes } from "../../../../server/settings-api.ts";

export const dynamic = "force-dynamic";

/**
 * The logo (or photo), public so the sign-in page can show it. Served with a type taken from its bytes when it was
 * stored, never sniffed again by the browser, and unable to run anything if opened directly.
 */
export async function GET(request: Request) {
  const logo = await readLogo(platform().pool);
  if (logo === null) return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
  const etag = `"${logo.sha256}"`;
  const headers = {
    etag,
    "cache-control": "public, max-age=0, must-revalidate",
    "content-type": logo.contentType,
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
  };
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(new Uint8Array(logo.bytes), { status: 200, headers });
}

/** Stores the logo: the raw image as the request body (PNG, JPEG or WebP, up to 512 KB). */
export async function PUT(request: Request) {
  const authorized = await authorizeWrite(request);
  if (authorized instanceof Response) return authorized;
  const body = await readBodyBytes(request, MAX_IMAGE_BYTES);
  if (!body.ok) return json({ error: body.message }, 413);
  const { pool } = platform();
  try {
    await new BrandService(pool).setLogo(body.bytes, authorized.actor);
  } catch (error) {
    if (error instanceof SettingValueError) return json({ error: error.message }, 422);
    throw error;
  }
  return json({ brand: await readBrand(pool) });
}

export async function DELETE(request: Request) {
  const authorized = await authorizeWrite(request);
  if (authorized instanceof Response) return authorized;
  const { pool } = platform();
  await new BrandService(pool).clearLogo(authorized.actor);
  return json({ brand: await readBrand(pool) });
}
