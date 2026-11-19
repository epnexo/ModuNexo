import { type McpRun, createMcpServer } from "@modunexo/core/mcp-server";

/** A JSON-RPC message is a few hundred bytes; a megabyte is far beyond any real tool call. */
export const MCP_MAX_BODY_BYTES = 1_048_576;

const BEARER = /^Bearer\s+(\S+)$/i;

/** The most commands that may wait for the one running; past it the caller is told the server is busy. */
export const MCP_MAX_QUEUE = 8;
const BUSY_EXIT = 75;
const MAX_ERROR_CHARS = 200;
const MAX_SCRUB_INPUT = 10_000;

export interface McpAuditEvent {
  /**
   * The service token's id (never the token itself). Not named `key`: the core logger redacts any field whose name
   * looks like a secret (`key`, `token`, ...), and this one is an identifier the operator needs to read.
   */
  caller: number;
  tool: string;
  /** The CLI's exit code, or null when the call was refused before it ran. */
  exit: number | null;
}

export interface McpHttpDeps {
  run: McpRun;
  version: string;
  /** Who is calling and may they write? Reads the key behind this bearer token. May throw when the platform cannot tell. */
  identify: (token: string) => Promise<{ keyId: number; write: boolean }>;
  /** One event per tool call. It carries no argument value and no key. */
  audit?: (event: McpAuditEvent) => void;
  maxBytes?: number;
  maxQueue?: number;
}

// IPv6 in its full and compressed forms, bare or in brackets with a port. It needs at least two colons and hex groups,
// so a time like 10:20:30 or a `module:version` pair is left alone.
const IPV6 = /\[[0-9a-f:.]*:[0-9a-f:.]*\](?::\d+)?|(?<![0-9a-z:])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,7}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,5})?|:(?::[0-9a-f]{1,4}){1,7}|::)(?::\d+)?(?![0-9a-z:])/gi;

/**
 * What a remote caller may read of a CLI failure: its first line, with credentials, addresses and file paths taken
 * out. The CLI's full text (stack frames, connection strings) stays on the server.
 */
export function scrubCliText(text: string): string {
  // The CLI's output is capped at 1 MiB, not at one line: bound the work before the patterns run over it.
  const first = text.slice(0, MAX_SCRUB_INPUT).split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
  const clean = first
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/mdnx_\S+/g, "[key]")
    .replace(/\b(password|passwd|pwd|secret|token|apikey|api_key)["']?\s*[=:]\s*["']?[^\s"',}]+/gi, "$1=[redacted]")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]")
    .replace(/\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS)[A-Z0-9_]*)=\S+/g, "$1=[redacted]")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "[address]")
    .replace(IPV6, "[address]")
    .replace(/\b(user|role|database)\s+"[^"]*"/gi, '$1 "[redacted]"')
    .replace(/(^|[\s("'=])\/[^\s"')]+/g, "$1[path]")
    .replace(/(^|[\s("'=])\.{1,2}[\\/][^\s"')]+/g, "$1[path]")
    .replace(/(^|[\s("'=])[A-Za-z]:\\[^\s"')]+/g, "$1[path]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]");
  return clean.length > MAX_ERROR_CHARS ? `${clean.slice(0, MAX_ERROR_CHARS)}…` : clean;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const empty = (status: number) => new Response(null, { status, headers: { "cache-control": "no-store" } });
const rpcError = (status: number, code: number, message: string) => json(status, { jsonrpc: "2.0", id: null, error: { code, message } });

class TooLarge extends Error {}

/** Reads the body up to `limit` bytes. The declared length is only a hint: the bytes actually read decide. */
async function readCapped(request: Request, limit: number): Promise<string> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new TooLarge();
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new TooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * MCP over HTTP in its stateless form: one JSON-RPC message per POST, one JSON reply. The caller's key was already
 * checked by `scopedRoute`; this only decides, from the key's scopes, whether the write tools exist for this request.
 * The environment switch MODUNEXO_MCP_WRITE belongs to stdio and is never read here.
 */
export function createMcpHttpHandler(deps: McpHttpDeps): (request: Request) => Promise<Response> {
  const maxBytes = deps.maxBytes ?? MCP_MAX_BODY_BYTES;
  const maxQueue = deps.maxQueue ?? MCP_MAX_QUEUE;
  // The CLI keeps a pool and process-wide state per run: one command at a time across every request, as in stdio.
  // At most `maxQueue` commands are running or waiting; one more is refused at once, so a caller cannot pile up work.
  let queue: Promise<unknown> = Promise.resolve();
  let pending = 0;
  const run: McpRun = async (argv, io) => {
    if (pending >= maxQueue) {
      io.err("the server is busy, try again in a moment");
      return BUSY_EXIT;
    }
    pending += 1;
    const next = queue.then(() => deps.run(argv, io), () => deps.run(argv, io));
    queue = next.catch(() => undefined);
    try {
      return await next;
    } finally {
      pending -= 1;
    }
  };

  return async (request) => {
    let text: string;
    try {
      text = await readCapped(request, maxBytes);
    } catch (error) {
      if (error instanceof TooLarge) return rpcError(413, -32600, "the request body is too large");
      throw error;
    }

    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return rpcError(400, -32700, "parse error");
    }

    const token = BEARER.exec(request.headers.get("authorization") ?? "")?.[1];
    if (token === undefined) return rpcError(401, -32600, "a key is required");
    let caller: { keyId: number; write: boolean };
    try {
      caller = await deps.identify(token);
    } catch {
      // Not a verdict on the caller: the platform could not check. Fail closed, and say so honestly.
      return rpcError(503, -32603, "service unavailable");
    }

    const server = createMcpServer({
      run,
      allowWrite: caller.write,
      version: deps.version,
      redact: scrubCliText,
      audit: (event) => deps.audit?.({ caller: caller.keyId, ...event }),
    });
    const reply = await server.handle(message);
    return reply === undefined ? empty(202) : json(200, reply);
  };
}
