const KEY_SHAPE = /^mdnx_[0-9a-f]{8}_[A-Za-z0-9_-]{20,64}$/;
const ADDRESS_SHAPE = /^https?:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?$/;

/**
 * The command that registers the endpoint in Claude Code, ready to paste. Null when there is no address to point at,
 * and null too when the address or the key has any character that could end the quoted header: it is a command line.
 */
export function mcpAddCommand(address: string | null, token: string): string | null {
  if (address === null) return null;
  const base = address.replace(/\/+$/, "");
  if (!ADDRESS_SHAPE.test(base) || !KEY_SHAPE.test(token)) return null;
  return `claude mcp add --transport http modunexo ${base}/svc/core/mcp --header "Authorization: Bearer ${token}"`;
}
