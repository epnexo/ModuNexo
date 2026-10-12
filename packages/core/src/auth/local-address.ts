/**
 * Whether an address belongs to the local network. The shell uses this when sign-in is switched off: it then serves
 * only requests that arrive from here, so an instance that is later reached through a proxy or a tunnel is closed,
 * not open. Anything that cannot be read as an address is not local; the rule fails closed.
 *
 * Local means loopback, private (RFC 1918), link-local and IPv6 unique-local addresses. Shared address space
 * (100.64.0.0/10, used by some VPNs) is deliberately not local: it is not a network the owner is known to control.
 */

/** Four decimal octets. Leading zeros are refused because some parsers read them as octal. */
function parseIPv4(text: string): [number, number, number, number] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets as [number, number, number, number];
}

/** Eight 16-bit groups, or null when the text is not a well-formed IPv6 address. */
function parseIPv6(text: string): number[] | null {
  let rest = text;
  const zone = rest.indexOf("%");
  if (zone !== -1) rest = rest.slice(0, zone);
  if (rest === "" || !/^[0-9a-fA-F:.]+$/.test(rest)) return null;

  // An IPv4 tail ("::ffff:192.168.1.5") stands for the last two groups.
  const lastColon = rest.lastIndexOf(":");
  const tail = rest.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIPv4(tail);
    if (v4 === null) return null;
    rest = `${rest.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }

  const halves = rest.split("::");
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const groups: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      groups.push(parseInt(group, 16));
    }
    return groups;
  };
  const head = toGroups(halves[0]!);
  if (head === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const back = toGroups(halves[1]!);
  if (back === null || head.length + back.length > 7) return null;
  return [...head, ...new Array<number>(8 - head.length - back.length).fill(0), ...back];
}

/** Removes the brackets and the port a proxy or a socket may add: "[::1]:3000", "192.168.1.5:51234". */
function stripDecoration(raw: string): string {
  const text = raw.trim();
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(text);
  if (bracketed !== null) return bracketed[1]!;
  const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(text);
  if (withPort !== null) return withPort[1]!;
  return text;
}

function isLocalIPv4([a, b]: [number, number, number, number]): boolean {
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

export function isLocalAddress(raw: string): boolean {
  const text = stripDecoration(raw);
  if (text === "") return false;

  const v4 = parseIPv4(text);
  if (v4 !== null) return isLocalIPv4(v4);

  const groups = parseIPv6(text);
  if (groups === null) return false;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [number, number, number, number, number, number, number, number];

  // ::1 is the loopback; :: is the unspecified address and says nothing about where a request came from.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0) return g7 === 1;
  // ::ffff:a.b.c.d is an IPv4 client seen through a dual-stack listener; judge the IPv4 address it wraps.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isLocalIPv4([g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff]);
  }
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  return false;
}

/** True only when the request carries at least one address and every address it carries is local. */
export function requestIsLocal(addresses: readonly string[]): boolean {
  return addresses.length > 0 && addresses.every(isLocalAddress);
}

/** The entries of a comma separated forwarding header ("x-forwarded-for"), trimmed, blanks dropped. */
export function splitForwarded(value: string | null | undefined): string[] {
  if (value === null || value === undefined) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}
