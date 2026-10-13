import { MasterKeyError, resolveMasterKey } from "@epnexo/core/auth";

type Env = Record<string, string | undefined>;

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 3000;

/** The web app cannot be launched as asked. The message names the variable to fix and never contains a secret. */
export class LaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaunchError";
  }
}

/** The command itself is wrong, as opposed to the environment. */
export class LaunchUsageError extends LaunchError {}

export interface Listen {
  host: string;
  port: number;
}

/** Where the web app listens: `WEB_HOST` and `WEB_PORT`, loopback and 3000 when unset. */
export function resolveListen(env: Env = process.env): Listen {
  const host = env.WEB_HOST?.trim() || DEFAULT_HOST;
  if (/[\s/]/.test(host) || /^[^:]+:\d+$/.test(host)) {
    throw new LaunchError(`WEB_HOST must be a bare host name or address such as 127.0.0.1 or 0.0.0.0, not "${host}"; the port goes in WEB_PORT`);
  }
  const rawPort = env.WEB_PORT?.trim() || String(DEFAULT_PORT);
  const port = /^\d{1,5}$/.test(rawPort) ? Number(rawPort) : Number.NaN;
  if (!(port >= 1 && port <= 65535)) throw new LaunchError(`WEB_PORT must be a whole number between 1 and 65535, not "${rawPort}"`);
  return { host, port };
}

/**
 * What to run for one launcher command. `build` runs `next build` as a child process. `dev` and `start` serve
 * through the platform's own HTTP server (see `scripts/serve.ts`), which stamps the connection address on every
 * request before Next.js sees it; `next start` alone cannot do that.
 *
 * `registry` is what happens to the generated module registry first. `generate`: rewritten from the modules
 * enabled in the database. `ensure`: an empty one is written only if none exists. `none`: the build has it.
 */
export type LaunchPlan =
  | { kind: "build"; nextArgs: string[]; registry: "generate" }
  | { kind: "serve"; dev: boolean; host: string; port: number; registry: "ensure" | "none" };

/**
 * Decides how to run the web app for one launcher command. Serving needs the master key, and that is checked
 * here, before anything listens, so a missing key is one clear line and not a failure at the first sign-in.
 */
export function planLaunch(command: string | undefined, env: Env = process.env): LaunchPlan {
  if (command === undefined) throw new LaunchUsageError("no command given: use dev, build or start");
  if (command !== "dev" && command !== "build" && command !== "start") throw new LaunchUsageError(`unknown command "${command}": use dev, build or start`);
  if (command === "build") return { kind: "build", nextArgs: ["build"], registry: "generate" };

  try {
    resolveMasterKey(env);
  } catch (error) {
    if (error instanceof MasterKeyError) throw new LaunchError(error.message);
    throw error;
  }
  const { host, port } = resolveListen(env);
  return { kind: "serve", dev: command === "dev", host, port, registry: command === "dev" ? "ensure" : "none" };
}

/**
 * The launcher's exit code for the Next.js child. A child killed by a signal nobody asked for (the out-of-memory
 * killer during a build, for one) is a failure; only the signal the launcher itself forwarded is a clean stop.
 */
export function exitCodeFor(code: number | null, signal: NodeJS.Signals | null, forwarded: NodeJS.Signals | null): number {
  if (code !== null) return code;
  return signal !== null && signal === forwarded ? 0 : 1;
}
