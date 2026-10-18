import { CLIENT_IP_HEADER, formatIp, parseIp, splitForwarded } from "@modunexo/core/auth";

export { CLIENT_IP_HEADER };

type NodeHeaders = Record<string, string | string[] | undefined>;

/**
 * Called by the web server for every request, before Next.js sees it. Whatever a client sent under the trusted
 * name is discarded, and the header is set from the connection itself, so it cannot be forged. When the
 * connection has no address the header is left absent, which the rest of the app reads as "not local".
 */
export function stampClientAddress(headers: NodeHeaders, remoteAddress: string | undefined): void {
  delete headers[CLIENT_IP_HEADER];
  if (remoteAddress === undefined || remoteAddress === "") return;
  // One canonical text per client (an IPv4 client of a dual-stack listener arrives as ::ffff:a.b.c.d), so it is one
  // identity for the limiter however it connected. What cannot be read is kept as it is, and is never local.
  const ip = parseIp(remoteAddress);
  headers[CLIENT_IP_HEADER] = ip === null ? remoteAddress : formatIp(ip);
}

/** The `for=` value of each hop in an RFC 7239 `Forwarded` header, unquoted and without brackets or port. */
export function parseForwarded(value: string): string[] {
  const found: string[] = [];
  for (const hop of value.split(",")) {
    for (const pair of hop.split(";")) {
      const match = /^\s*for\s*=\s*(.+?)\s*$/i.exec(pair);
      if (match === null) continue;
      let address = match[1]!.replace(/^"(.*)"$/, "$1");
      const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(address);
      if (bracketed !== null) address = bracketed[1]!;
      found.push(address);
    }
  }
  return found;
}

const SINGLE_VALUE_HEADERS = ["x-real-ip", "cf-connecting-ip", "true-client-ip", "x-client-ip"] as const;

/**
 * Every address a request carries, the connection's own first. A request that was not stamped by the web server
 * has no trusted connection address, so the list is empty and nothing the client wrote is believed.
 */
export function requestAddresses(headers: Pick<Headers, "get">): string[] {
  const connection = headers.get(CLIENT_IP_HEADER)?.trim();
  if (connection === undefined || connection === "") return [];
  const addresses = [connection, ...splitForwarded(headers.get("x-forwarded-for")), ...parseForwarded(headers.get("forwarded") ?? "")];
  for (const name of SINGLE_VALUE_HEADERS) {
    const value = headers.get(name)?.trim();
    if (value !== undefined && value !== "") addresses.push(value);
  }
  return addresses;
}
