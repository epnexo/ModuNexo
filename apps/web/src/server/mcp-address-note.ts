import type { ApiAddressSource } from "@modunexo/core/api-access";

/**
 * The warning shown under the MCP address when the platform guessed it. An address taken from the Host header is whatever the
 * browser used to open this page (a local name, an IP, a proxy's inner address), so a command built on it may not work from another
 * machine. A saved address or `WEB_PUBLIC_URL` is a choice, and needs no warning.
 */
export function addressNote(source: ApiAddressSource): string | null {
  return source === "request"
    ? "This address comes from the Host header of this request, so it may not be the one other machines can reach. Save the real one in a module's API access, or set WEB_PUBLIC_URL."
    : null;
}
