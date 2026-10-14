// Launcher for the web app: `npm run web:dev`, `npm run web:build`, `npm run web:start`.
// It runs Next.js with the host, port and checks the platform's environment asks for, so the web app needs no
// environment file of its own: everything comes from the repository's `.env`.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runCli } from "@epnexo/core/cli";
import { pidFilePath } from "@epnexo/core/install";
import { DATA_DIR } from "@epnexo/core/packages";
import { LaunchError, LaunchUsageError, exitCodeFor, planLaunch } from "../src/server/launch.ts";
import { superviseChild } from "../src/server/supervisor.ts";
import { ensureRegistry } from "./ensure-registry.ts";

const webRoot = fileURLToPath(new URL("../", import.meta.url));

/** Runs a Node script as a child, forwards the stop signals to it and returns the exit code to use. */
function runChild(args: string[]): Promise<number> {
  const child = spawn(process.execPath, args, { cwd: webRoot, stdio: "inherit" });
  let forwarded: NodeJS.Signals | null = null;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      forwarded = signal;
      child.kill(signal);
    });
  }
  return new Promise((resolve) => {
    child.on("error", (error) => {
      console.error(`error: could not start ${args[1] ?? "the web app"}: ${error.message}`);
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      if (signal !== null && signal !== forwarded) console.error(`error: the web app process was killed by ${signal}`);
      resolve(exitCodeFor(code, signal, forwarded));
    });
  });
}

async function main(): Promise<number> {
  const plan = planLaunch(process.argv[2]);

  if (plan.registry === "generate") {
    const code = await runCli(["registry:generate"]);
    if (code !== 0) return code;
  } else if (plan.registry === "ensure") {
    ensureRegistry(webRoot);
  }

  if (plan.kind === "serve") {
    // Node's own TypeScript support, not the tsx loader this process runs under: see the note in serve.ts.
    const serveScript = fileURLToPath(new URL("./serve.ts", import.meta.url));
    const serveArgs = ["--disable-warning=ExperimentalWarning", serveScript, plan.dev ? "dev" : "start", plan.host, String(plan.port)];
    if (plan.dev) return runChild(serveArgs);
    // Production runs under a small supervisor: an install asks it (SIGUSR2, via the pid file) to restart the
    // server so the new build is served. It restarts on that request only, never because the server died.
    return superviseChild({ args: serveArgs, cwd: webRoot, pidFile: pidFilePath(DATA_DIR), signals: process });
  }
  return runChild([createRequire(import.meta.url).resolve("next/dist/bin/next"), ...plan.nextArgs]);
}

try {
  process.exitCode = await main();
} catch (error) {
  if (!(error instanceof LaunchError)) throw error;
  console.error(`error: ${error.message}`);
  process.exitCode = error instanceof LaunchUsageError ? 2 : 1;
}
