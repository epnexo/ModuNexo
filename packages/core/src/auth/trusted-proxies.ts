import type pg from "pg";
import { SettingValueError } from "../settings/errors.ts";
import { type Cidr, parseCidr } from "./ip.ts";

export const TRUSTED_PROXIES_KEY = "security.trustedProxies";
export const MAX_TRUSTED_PROXIES = 50;
/** The shortest prefix accepted, in bits. A list of proxies is not a place for half the internet. */
export const MIN_IPV4_PREFIX = 8;
export const MIN_IPV6_PREFIX = 8;

export type TrustedProxiesValidation = { ok: true; value: string[] } | { ok: false; message: string };

/**
 * Checks a list of reverse proxies whose `x-forwarded-for` may be believed: addresses and CIDR ranges, given as a
 * list or as text separated by commas or lines. A range that is the whole address space is refused: it would trust
 * every client, which is the opposite of what the setting is for.
 */
export function validateTrustedProxies(input: unknown): TrustedProxiesValidation {
  const refuse = (rule: string): TrustedProxiesValidation => ({ ok: false, message: `${TRUSTED_PROXIES_KEY}: ${rule}` });
  let entries: string[];
  if (typeof input === "string") entries = input.split(/[,\n]/);
  else if (Array.isArray(input) && input.every((item) => typeof item === "string")) entries = input as string[];
  else return refuse("must be a list of addresses and CIDR ranges, or text separated by commas or lines");

  const value: string[] = [];
  for (const raw of entries) {
    const entry = raw.trim();
    if (entry === "" || value.includes(entry)) continue;
    const range = parseCidr(entry);
    if (range === null) return refuse(`"${entry}" is not an IP address or a CIDR range such as 10.0.0.0/24`);
    if (range.prefix === 0) return refuse(`"${entry}" would trust every address, which defeats the purpose; list the proxies themselves`);
    const shortest = range.version === 4 ? MIN_IPV4_PREFIX : MIN_IPV6_PREFIX;
    if (range.prefix < shortest) {
      return refuse(`"${entry}" is too broad to be a list of proxies: use a prefix of /${shortest} or longer, or list the proxies themselves`);
    }
    value.push(entry);
  }
  if (value.length > MAX_TRUSTED_PROXIES) return refuse(`at most ${MAX_TRUSTED_PROXIES} entries are allowed`);
  return { ok: true, value };
}

/** The stored list as the owner wrote it, for the screen. Empty when nothing is stored or what is stored is not valid. */
export async function readTrustedProxyList(pool: pg.Pool): Promise<string[]> {
  const { rows } = await pool.query("select value from core.platform_settings where key = $1", [TRUSTED_PROXIES_KEY]);
  // The same strictness as `readTrustedProxies`: only a stored list counts, so the screen never shows as active
  // something that is not trusted.
  if (!Array.isArray(rows[0]?.value)) return [];
  const checked = validateTrustedProxies(rows[0].value);
  return checked.ok ? checked.value : [];
}

/**
 * The ranges the shell trusts. A stored value that does not validate as a whole trusts nobody: the limiter then
 * counts the connection address, which can lock a proxy's clients together but never lets a forged header through.
 */
export async function readTrustedProxies(pool: pg.Pool): Promise<Cidr[]> {
  const { rows } = await pool.query("select value from core.platform_settings where key = $1", [TRUSTED_PROXIES_KEY]);
  const stored: unknown = rows[0]?.value;
  if (!Array.isArray(stored)) return [];
  const checked = validateTrustedProxies(stored);
  if (!checked.ok) return [];
  return checked.value.map((entry) => parseCidr(entry)).filter((range): range is Cidr => range !== null);
}

/** Validates and stores the list. An empty list removes the setting. A refused list changes and logs nothing. */
export async function setTrustedProxies(pool: pg.Pool, input: unknown, actor: string): Promise<string[]> {
  const checked = validateTrustedProxies(input);
  if (!checked.ok) throw new SettingValueError(checked.message);
  const client = await pool.connect();
  try {
    await client.query("begin");
    if (checked.value.length === 0) {
      const removed = await client.query("delete from core.platform_settings where key = $1", [TRUSTED_PROXIES_KEY]);
      if ((removed.rowCount ?? 0) > 0) {
        await client.query("insert into core.settings_events (scope, key, action, actor) values ('platform', $1, 'unset', $2)", [TRUSTED_PROXIES_KEY, actor]);
      }
    } else {
      await client.query(
        `insert into core.platform_settings (key, value, updated_by) values ($1, $2::jsonb, $3)
         on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by`,
        [TRUSTED_PROXIES_KEY, JSON.stringify(checked.value), actor],
      );
      await client.query("insert into core.settings_events (scope, key, action, actor) values ('platform', $1, 'set', $2)", [TRUSTED_PROXIES_KEY, actor]);
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return checked.value;
}
