import { type BrandState, readBrand } from "@modunexo/core/settings";
import { platform } from "./platform.ts";

/** The identity to present, or the default when nothing is set or the database cannot be asked (a page must still render). */
export async function loadBrand(): Promise<BrandState> {
  try {
    return await readBrand(platform().pool);
  } catch {
    return { profile: null, logo: null };
  }
}
