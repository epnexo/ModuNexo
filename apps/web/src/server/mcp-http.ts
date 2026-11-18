import { type McpRun, createMcpServer } from "@modunexo/core/mcp-server";

/** A JSON-RPC message is a few hundred bytes; a megabyte is far beyond any real tool call. */
export const MCP_MAX_BODY_BYTES = 1_048_576;

const BEARER = /^Bearer\s+(\S+)$/i;

export interface McpHttpDeps {
  run: McpRun;
  version: string;
  /** Does the key behind this bearer token hold the write scope? May throw when the platform cannot tell. */
  canWrite: (token: string) => Promise<boolean>;
  maxBytes?: number;
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
  // The CLI keeps a pool and process-wide state per run: one command at a time across every request, as in stdio.
  let queue: Promise<unknown> = Promise.resolve();
  const run: McpRun = (argv, io) => {
    const next = queue.then(() => deps.run(argv, io), () => deps.run(argv, io));
    queue = next.catch(() => undefined);
    return next;
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
    let allowWrite: boolean;
    try {
      allowWrite = await deps.canWrite(token);
    } catch {
      // Not a verdict on the caller: the platform could not check. Fail closed, and say so honestly.
      return rpcError(503, -32603, "service unavailable");
    }

    const reply = await createMcpServer({ run, allowWrite, version: deps.version }).handle(message);
    return reply === undefined ? empty(202) : json(200, reply);
  };
}
