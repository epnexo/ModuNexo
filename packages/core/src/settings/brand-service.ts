import type pg from "pg";
import { type BrandProfile, type ImageType, validateImage, validateProfile } from "./brand.ts";
import { SettingValueError } from "./service.ts";

const PROFILE_KEY = "brand.profile";

export interface BrandState {
  profile: BrandProfile | null;
  /** The sha256 of the stored logo, or null; it names the image's URL so a new image is never served stale. */
  logo: string | null;
}

export interface StoredImage {
  contentType: ImageType;
  bytes: Buffer;
  sha256: string;
}

/** What the shell needs to present itself, with no registry and no writes. */
export async function readBrand(pool: pg.Pool): Promise<BrandState> {
  const profile = await pool.query("select value from core.platform_settings where key = $1", [PROFILE_KEY]);
  const logo = await pool.query("select sha256 from core.brand_assets where kind = 'logo'");
  const checked = profile.rows[0] === undefined ? null : validateProfile(profile.rows[0].value);
  return { profile: checked !== null && checked.ok ? checked.value : null, logo: (logo.rows[0]?.sha256 as string | undefined) ?? null };
}

export async function readLogo(pool: pg.Pool): Promise<StoredImage | null> {
  const { rows } = await pool.query("select content_type, bytes, sha256 from core.brand_assets where kind = 'logo'");
  const row = rows[0] as { content_type: ImageType; bytes: Buffer; sha256: string } | undefined;
  return row === undefined ? null : { contentType: row.content_type, bytes: row.bytes, sha256: row.sha256 };
}

/** Writes the profile and the logo, each change recorded in `core.settings_events`. */
export class BrandService {
  constructor(private readonly pool: pg.Pool) {}

  get(): Promise<BrandState> {
    return readBrand(this.pool);
  }

  async setProfile(input: unknown, actor: string): Promise<BrandProfile> {
    const checked = validateProfile(input);
    if (!checked.ok) throw new SettingValueError(checked.message);
    await this.transaction(async (client) => {
      await client.query(
        `insert into core.platform_settings (key, value, updated_by) values ($1, $2::jsonb, $3)
         on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by`,
        [PROFILE_KEY, JSON.stringify(checked.value), actor],
      );
      await client.query("insert into core.settings_events (scope, key, action, actor) values ('platform', $1, 'set', $2)", [PROFILE_KEY, actor]);
    });
    return checked.value;
  }

  async setLogo(bytes: Uint8Array, actor: string): Promise<string> {
    const checked = validateImage(bytes);
    if (!checked.ok) throw new SettingValueError(checked.message);
    await this.transaction(async (client) => {
      await client.query(
        `insert into core.brand_assets (kind, content_type, bytes, sha256, updated_by) values ('logo', $1, $2, $3, $4)
         on conflict (kind) do update set content_type = excluded.content_type, bytes = excluded.bytes, sha256 = excluded.sha256, updated_at = now(), updated_by = excluded.updated_by`,
        [checked.value.contentType, Buffer.from(bytes), checked.value.sha256, actor],
      );
      await client.query("insert into core.settings_events (scope, key, action, actor) values ('platform', 'brand.logo', 'set', $1)", [actor]);
    });
    return checked.value.sha256;
  }

  /** Removes the logo; with none stored nothing is logged. */
  async clearLogo(actor: string): Promise<void> {
    await this.transaction(async (client) => {
      const removed = await client.query("delete from core.brand_assets where kind = 'logo'");
      if ((removed.rowCount ?? 0) > 0) await client.query("insert into core.settings_events (scope, key, action, actor) values ('platform', 'brand.logo', 'unset', $1)", [actor]);
    });
  }

  /** Removes the whole identity so the shell goes back to its default name. */
  async clearProfile(actor: string): Promise<void> {
    await this.transaction(async (client) => {
      const removed = await client.query("delete from core.platform_settings where key = $1", [PROFILE_KEY]);
      if ((removed.rowCount ?? 0) > 0) await client.query("insert into core.settings_events (scope, key, action, actor) values ('platform', $1, 'unset', $2)", [PROFILE_KEY, actor]);
    });
  }

  private async transaction(run: (client: pg.PoolClient) => Promise<void>): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await run(client);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
