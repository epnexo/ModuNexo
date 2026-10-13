// This file is run by Node itself (native TypeScript support), not through the launcher's tsx loader: Next compiles
// next.config.ts when it loads it, and that compile fails under a second TypeScript loader. Keep it, and what it
// imports, to syntax Node can strip: no enums, namespaces or parameter properties.
//
// The web server: Next.js behind a thin Node HTTP server that stamps the address of each connection on the
// request before Next.js sees it. Next.js fills x-forwarded-for from the socket only when the client did not send
// one, so without this step a route could not tell a real address from a forged one.
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import next from "next";
import { stampClientAddress } from "../src/server/client-address.ts";
import { closePlatform } from "../src/server/platform-lifecycle.ts";

export interface ServeOptions {
  dev: boolean;
  host: string;
  port: number;
  /** The web app directory. */
  dir: string;
}

/** After a stop signal: idle connections are closed at once, the rest get this long to finish, then they are cut. */
export const GRACE_MS = 5_000;
/** The hard limit for the HTTP server to finish closing. */
export const DEADLINE_MS = 8_000;
/** What is left for closing Next.js and the database pool once the server is down. */
export const TEARDOWN_MS = 3_000;

/** Starts the server and resolves when it has been stopped by SIGINT or SIGTERM. */
export async function serve({ dev, host, port, dir }: ServeOptions): Promise<void> {
  const app = next({ dev, dir, hostname: host, port });
  await app.prepare();
  const handle = app.getRequestHandler();
  const upgrade = app.getUpgradeHandler();

  const fail = (error: unknown, response?: ServerResponse) => {
    console.error("request failed:", error instanceof Error ? error.message : error);
    if (response === undefined || response.headersSent) response?.destroy();
    else {
      response.statusCode = 500;
      response.end("Internal Server Error");
    }
  };

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    stampClientAddress(request.headers, request.socket.remoteAddress);
    handle(request, response).catch((error: unknown) => fail(error, response));
  });
  server.on("upgrade", (request, socket, head) => {
    stampClientAddress(request.headers, request.socket.remoteAddress);
    upgrade(request, socket, head).catch((error: unknown) => {
      fail(error);
      socket.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      console.log(`epnexo web (${dev ? "development" : "production"}) listening on http://${host.includes(":") ? `[${host}]` : host}:${port}`);
      resolve();
    });
  });

  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = () => {
      if (stopping) {
        // A second signal means "now".
        server.closeAllConnections();
        return;
      }
      stopping = true;
      server.close(() => resolve());
      server.closeIdleConnections();
      setTimeout(() => server.closeAllConnections(), GRACE_MS).unref();
      setTimeout(resolve, DEADLINE_MS).unref();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  // Closing the pool waits for checked-out clients, so one stuck query could hold the process open: bound it.
  await Promise.race([Promise.allSettled([app.close(), closePlatform()]), new Promise((resolve) => setTimeout(resolve, TEARDOWN_MS))]);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, host, rawPort] = process.argv.slice(2);
  const port = Number(rawPort);
  if ((mode !== "dev" && mode !== "start") || host === undefined || !Number.isInteger(port)) {
    console.error("usage: serve.ts <dev|start> <host> <port>");
    process.exit(2);
  }
  try {
    await serve({ dev: mode === "dev", host, port, dir: fileURLToPath(new URL("../", import.meta.url)) });
    // Whatever refused to close inside the limits above does not get to keep the process alive.
    process.exit(0);
  } catch (error) {
    const code = (error as { code?: string }).code;
    console.error(code === "EADDRINUSE" ? `error: ${host}:${port} is already in use; change WEB_PORT or stop the other process` : `error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
