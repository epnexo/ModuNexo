import { runCli } from "../cli/run.ts";
import { CORE_VERSION } from "../version.ts";
import { createMcpServer } from "./server.ts";
import { serveStdio } from "./stdio.ts";

export { createMcpServer, serveStdio };

/**
 * `modunexo mcp`: serve the platform to an MCP client over stdin and stdout. Standard output belongs to the protocol,
 * so anything the platform logs goes to standard error. Writes are off unless MODUNEXO_MCP_WRITE=1.
 */
export async function serveMcp(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  for (const method of ["log", "info", "debug", "warn"] as const) console[method] = console.error;
  const server = createMcpServer({ run: runCli, allowWrite: env.MODUNEXO_MCP_WRITE === "1", version: CORE_VERSION });
  await serveStdio(process.stdin, process.stdout, server);
}
