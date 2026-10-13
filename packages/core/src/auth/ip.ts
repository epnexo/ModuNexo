import { parseIPv4, parseIPv6, stripDecoration } from "./local-address.ts";

/** An address as a number, with its family. An IPv4-mapped IPv6 address is the IPv4 address it wraps. */
export interface ParsedIp {
  version: 4 | 6;
  value: bigint;
}

const BITS = { 4: 32, 6: 128 } as const;

export function parseIp(text: string): ParsedIp | null {
  const bare = stripDecoration(text);
  if (bare === "") return null;
  const v4 = parseIPv4(bare);
  if (v4 !== null) return { version: 4, value: v4.reduce((acc, octet) => (acc << 8n) | BigInt(octet), 0n) };
  const groups = parseIPv6(bare);
  if (groups === null) return null;
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return { version: 4, value: (BigInt(groups[6]!) << 16n) | BigInt(groups[7]!) };
  }
  return { version: 6, value: groups.reduce((acc, group) => (acc << 16n) | BigInt(group), 0n) };
}

/** One canonical text for an address, so the same client is the same key however it was written. */
export function formatIp(ip: ParsedIp): string {
  if (ip.version === 4) return [24n, 16n, 8n, 0n].map((shift) => String((ip.value >> shift) & 0xffn)).join(".");
  const groups: string[] = [];
  for (let shift = 112n; shift >= 0n; shift -= 16n) groups.push(((ip.value >> shift) & 0xffffn).toString(16));
  return groups.join(":");
}

export interface Cidr {
  version: 4 | 6;
  network: bigint;
  mask: bigint;
  /** How many leading bits are fixed: 32 or 128 for a single host, 0 for the whole address space. */
  prefix: number;
}

/** `10.0.0.0/8`, `fd00::/8`, or a bare address, which is a range of one. */
export function parseCidr(text: string): Cidr | null {
  const parts = text.split("/");
  if (parts.length > 2) return null;
  const ip = parseIp(parts[0]!);
  if (ip === null) return null;
  let prefix: number = BITS[ip.version];
  if (parts.length === 2) {
    if (!/^\d{1,3}$/.test(parts[1]!)) return null;
    // A mapped IPv6 address read as IPv4 has no meaningful IPv4 prefix to go with it.
    if (ip.version === 4 && parts[0]!.includes(":")) return null;
    prefix = Number(parts[1]);
    if (prefix > BITS[ip.version]) return null;
  }
  const bits = BigInt(BITS[ip.version]);
  const host = (1n << (bits - BigInt(prefix))) - 1n;
  const mask = ((1n << bits) - 1n) ^ host;
  return { version: ip.version, network: ip.value & mask, mask, prefix };
}

export function cidrContains(cidr: Cidr, ip: ParsedIp): boolean {
  return cidr.version === ip.version && (ip.value & cidr.mask) === cidr.network;
}

/**
 * Who the sign-in limiter should count. A client can write any `x-forwarded-for`, so the header is believed only
 * when the connection itself comes from a proxy the owner trusts, and then it is read from the right: each proxy
 * appends the address it received from, so the nearest address that is not a trusted proxy is the first one no
 * trusted party vouches for. An entry that cannot be read ends the walk at the connection, because a made-up
 * string would otherwise be a new identity for every request.
 */
export function effectiveClientAddress(connection: string, forwardedFor: readonly string[], trusted: readonly Cidr[]): string {
  const conn = parseIp(connection);
  if (conn === null) return connection;
  const isTrusted = (ip: ParsedIp) => trusted.some((range) => cidrContains(range, ip));
  const fallback = formatIp(conn);
  if (!isTrusted(conn)) return fallback;
  for (let i = forwardedFor.length - 1; i >= 0; i--) {
    const entry = parseIp(forwardedFor[i]!);
    if (entry === null) return fallback;
    if (isTrusted(entry)) continue;
    return formatIp(entry);
  }
  return fallback;
}
