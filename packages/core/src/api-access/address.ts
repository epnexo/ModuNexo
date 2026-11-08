import type pg from "pg";
import { SettingValueError } from "../settings/service.ts";

/** The platform setting that holds the address an administrator chose to show to API clients. */
export const API_ADDRESS_KEY = "api.address";

/**
 * The origin of a web address: scheme, host and port. A path, query or fragment is dropped, since the platform is
 * served from the root. Anything that is not an http or https address, or that carries credentials, is refused.
 */
export function normalizeApiAddress(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new SettingValueError("the address must be a web address such as https://modunexo.example.com");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.hostname === "") {
    throw new SettingValueError("the address must start with http:// or https://");
  }
  if (url.username !== "" || url.password !== "") throw new SettingValueError("the address must not contain a user name or a password");
  return url.origin;
}

export type ApiAddressSource = "saved" | "public-url" | "request" | "none";

/** What to show as the platform's address: the one an administrator saved, else `WEB_PUBLIC_URL`, else the request's own. */
export function resolveApiAddress(input: { saved: string | null; publicUrl: string | undefined; requestOrigin: string | null }): { address: string | null; source: ApiAddressSource } {
  if (input.saved !== null) return { address: input.saved, source: "saved" };
  if (input.publicUrl !== undefined) return { address: input.publicUrl, source: "public-url" };
  if (input.requestOrigin !== null) return { address: input.requestOrigin, source: "request" };
  return { address: null, source: "none" };
}

/** Reads and writes the saved address in `core.platform_settings`, with a trail of who changed it (never the value). */
export class ApiAddressService {
  constructor(private readonly pool: pg.Pool) {}

  async get(): Promise<string | null> {
    const { rows } = await this.pool.query("select value from core.platform_settings where key = $1", [API_ADDRESS_KEY]);
    const value: unknown = rows[0]?.value;
    return typeof value === "string" ? value : null;
  }

  async set(raw: string, actor: string): Promise<string> {
    const address = normalizeApiAddress(raw);
    await this.write(actor, async (client) => {
      await client.query(
        `insert into core.platform_settings (key, value, updated_by) values ($1, $2::jsonb, $3)
         on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by`,
        [API_ADDRESS_KEY, JSON.stringify(address), actor],
      );
      return "set";
    });
    return address;
  }

  /** Removes the saved address so the platform's own applies again. With nothing saved nothing is logged. */
  async unset(actor: string): Promise<void> {
    await this.write(actor, async (client) => {
      const removed = await client.query("delete from core.platform_settings where key = $1", [API_ADDRESS_KEY]);
      return (removed.rowCount ?? 0) > 0 ? "unset" : null;
    });
  }

  private async write(actor: string, change: (client: pg.PoolClient) => Promise<"set" | "unset" | null>): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const action = await change(client);
      if (action !== null) await client.query("insert into core.settings_events (scope, key, action, actor) values ('platform', $1, $2, $3)", [API_ADDRESS_KEY, action, actor]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
