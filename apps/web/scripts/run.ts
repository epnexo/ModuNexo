// Launcher for the web app: `npm run web:dev`, `npm run web:build`, `npm run web:start`.
// It runs Next.js with the host, port and checks the platform's environment asks for, so the web app needs no
// environment file of its own: everything comes from the repository's `.env`.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runCli } from "@epnexo/core/cli";
import { LaunchError, LaunchUsageError, planLaunch } from "../src/server/launch.ts";
import { ensureRegistry } from "./ensure-registry.ts";

const webRoot = fileURLToPath(new URL("../", import.meta.url));

async function main(): Promise<number> {
  const plan = planLaunch(process.argv[2]);

  if (plan.registry === "generate") {
    const code = await runCli(["registry:generate"]);
    if (code !== 0) return code;
  } else if (plan.registry === "ensure") {
    ensureRegistry(webRoot);
  }

  const next = createRequire(import.meta.url).resolve("next/dist/bin/next");
  const child = spawn(process.execPath, [next, ...plan.nextArgs], { cwd: webRoot, stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
  return new Promise((resolve) => {
    child.on("error", (error) => {
      console.error(`error: could not start Next.js: ${error.message}`);
      resolve(1);
    });
    child.on("exit", (code, signal) => resolve(code ?? (signal === null ? 1 : 0)));
  });
}

try {
  process.exitCode = await main();
} catch (error) {
  if (!(error instanceof LaunchError)) throw error;
  console.error(`error: ${error.message}`);
  process.exitCode = error instanceof LaunchUsageError ? 2 : 1;
}
