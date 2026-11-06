import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

interface Handler {
  handle: (message: unknown) => Promise<object | undefined>;
}

/**
 * The MCP stdio transport: one JSON message per line in, one per line out, nothing else on the output. Lines are
 * handled in order. A line that is not JSON gets a parse error with a null id and the loop goes on.
 */
export async function serveStdio(input: Readable, output: Writable, server: Handler): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    if (line.trim() === "") continue;
    let reply: object | undefined;
    try {
      reply = await server.handle(JSON.parse(line));
    } catch (error) {
      reply = error instanceof SyntaxError ? { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } } : { jsonrpc: "2.0", id: null, error: { code: -32603, message: "internal error" } };
    }
    if (reply !== undefined) output.write(`${JSON.stringify(reply)}\n`);
  }
}
