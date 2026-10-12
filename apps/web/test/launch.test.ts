import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { DEFAULT_HOST, DEFAULT_PORT, LaunchError, planLaunch, resolveListen } from "../src/server/launch.ts";

const KEY = "k".repeat(32);

describe("resolveListen", () => {
  it("defaults to the loopback address and port 3000", () => {
    assert.deepEqual(resolveListen({}), { host: DEFAULT_HOST, port: DEFAULT_PORT });
    assert.deepEqual(resolveListen({}), { host: "127.0.0.1", port: 3000 });
  });

  it("reads WEB_HOST and WEB_PORT", () => {
    assert.deepEqual(resolveListen({ WEB_HOST: "0.0.0.0", WEB_PORT: "8080" }), { host: "0.0.0.0", port: 8080 });
  });

  it("treats blank values as unset", () => {
    assert.deepEqual(resolveListen({ WEB_HOST: "  ", WEB_PORT: "" }), { host: "127.0.0.1", port: 3000 });
  });

  it("refuses a port that is not a whole number between 1 and 65535, naming the variable", () => {
    for (const value of ["0", "65536", "-1", "80.5", "abc", "3000x", "1e3"]) {
      assert.throws(
        () => resolveListen({ WEB_PORT: value }),
        (error: unknown) => error instanceof LaunchError && error.message.includes("WEB_PORT") && error.message.includes(value),
        value,
      );
    }
  });

  it("refuses a host with whitespace or a scheme, naming the variable", () => {
    for (const value of ["http://127.0.0.1", "my host", "127.0.0.1:3000/"]) {
      assert.throws(() => resolveListen({ WEB_HOST: value }), (error: unknown) => error instanceof LaunchError && error.message.includes("WEB_HOST"), value);
    }
  });
});

describe("planLaunch", () => {
  it("start listens where the environment says and needs the master key", () => {
    assert.deepEqual(planLaunch("start", { EPNEXO_MASTER_KEY: KEY, WEB_HOST: "0.0.0.0", WEB_PORT: "4000" }), {
      nextArgs: ["start", "--hostname", "0.0.0.0", "--port", "4000"],
      registry: "none",
    });
  });

  it("dev listens the same way and creates the registry only when it is missing", () => {
    assert.deepEqual(planLaunch("dev", { EPNEXO_MASTER_KEY: KEY }), { nextArgs: ["dev", "--hostname", "127.0.0.1", "--port", "3000"], registry: "ensure" });
  });

  it("build regenerates the registry from the database and needs no master key", () => {
    assert.deepEqual(planLaunch("build", {}), { nextArgs: ["build"], registry: "generate" });
  });

  it("start and dev refuse without a master key, naming the variable", () => {
    for (const command of ["start", "dev"]) {
      assert.throws(() => planLaunch(command, {}), (error: unknown) => error instanceof LaunchError && error.message.includes("EPNEXO_MASTER_KEY"), command);
      assert.throws(() => planLaunch(command, { EPNEXO_MASTER_KEY: "short" }), (error: unknown) => error instanceof LaunchError && !error.message.includes("short"), command);
    }
  });

  it("refuses an unknown or missing command", () => {
    assert.throws(() => planLaunch("deploy", { EPNEXO_MASTER_KEY: KEY }), /unknown command "deploy"/);
    assert.throws(() => planLaunch(undefined, { EPNEXO_MASTER_KEY: KEY }), /dev, build or start/);
  });
});

describe("the launcher script", () => {
  const script = fileURLToPath(new URL("../scripts/run.ts", import.meta.url));
  const run = (args: string[], env: Record<string, string>) =>
    new Promise<{ code: number; stderr: string }>((resolve) => {
      // Only the variables the case gives; Next's types make NODE_ENV required in ProcessEnv, hence the cast.
      const childEnv = { PATH: process.env.PATH, ...env } as unknown as NodeJS.ProcessEnv;
      execFile(process.execPath, ["--import", "tsx", script, ...args], { env: childEnv, timeout: 20_000 }, (error, _stdout, stderr) => {
        resolve({ code: error === null ? 0 : ((error as { code?: number }).code ?? 1), stderr });
      });
    });

  it("exits with 1 before starting anything when the master key is missing", async () => {
    const result = await run(["start"], {});
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^error: EPNEXO_MASTER_KEY is not set/);
  });

  it("exits with 1 on a bad port and with 2 on an unknown command", async () => {
    const badPort = await run(["start"], { EPNEXO_MASTER_KEY: KEY, WEB_PORT: "seventy" });
    assert.equal(badPort.code, 1);
    assert.match(badPort.stderr, /WEB_PORT/);
    const unknown = await run(["deploy"], { EPNEXO_MASTER_KEY: KEY });
    assert.equal(unknown.code, 2);
  });
});
