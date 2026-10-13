// This file is run by Node itself (native TypeScript support), not through the launcher's tsx loader: Next compiles
// next.config.ts when it loads it, and that compile fails under a second TypeScript loader. Keep it, and what it
// imports, to syntax Node can strip: no enums, namespaces or parameter properties.
//
// The web server: Next.js behind a thin Node HTTP server that stamps the address of each connection on the
// request before Next.js sees it. Next.js fills x-forwarded-for from the socket only when the client did not send
// one, so without this step a route could not tell a real address from a forged one.
import { createServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import next from "next";
import { stampClientAddress } from "../src/server/client-address.ts";

export interface ServeOptions {
  dev: boolean;
  host: string;
  port: number;
  /** The web app directory. */
  dir: string;
}

/** Starts the server and resolves when it has been closed by SIGINT or SIGTERM. */
export async function serve({ dev, host, port, dir }: ServeOptions): Promise<void> {
  const app = next({ dev, dir, hostname: host, port });
  await app.prepare();
  const handle = app.getRequestHandler();
  const upgrade = app.getUpgradeHandler();

  const server = createServer((request, response) => {
    stampClientAddress(request.headers, request.socket.remoteAddress);
    void handle(request, response);
  });
  server.on("upgrade", (request, socket, head) => {
    stampClientAddress(request.headers, request.socket.remoteAddress);
    void upgrade(request, socket, head);
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
    const stop = () => {
      server.close(() => resolve());
      // Keep-alive connections would hold the close open; end the idle ones now.
      server.closeIdleConnections();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await app.close();
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, host, rawPort] = process.argv.slice(2);
  const port = Number(rawPort);
  if ((mode !== "dev" && mode !== "start") || host === undefined || !Number.isInteger(port)) {
    console.error("usage: serve.ts <dev|start> <host> <port>");
    process.exit(2);
  }
  await serve({ dev: mode === "dev", host, port, dir: fileURLToPath(new URL("../", import.meta.url)) });
}
