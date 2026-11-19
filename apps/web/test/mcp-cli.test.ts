import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { allowedChildEnv, createCliRun } from "../src/server/mcp-cli.ts";

// `node -e <script> -- <argv>`: the script plays the CLI, so these tests need no database.
const run = (script: string, options: { timeoutMs?: number; maxBytes?: number } = {}) => createCliRun({ entry: ["-e", script, "--"], cwd: process.cwd(), env: { PATH: process.env.PATH ?? "" }, ...options });
const capture = async (cli: ReturnType<typeof run>, argv: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await cli(argv, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err };
};

describe("running the CLI as a child process", () => {
  it("passes the argv as separate arguments, never through a shell, and reports lines and exit code", async () => {
    const got = await capture(run("console.log(JSON.stringify(process.argv.slice(1))); console.error('oops'); process.exit(3)"), ["modules", "disable", "a b; touch x", "$(id)"]);
    assert.equal(got.code, 3);
    assert.deepEqual(JSON.parse(got.out.join("\n")), ["modules", "disable", "a b; touch x", "$(id)"]);
    assert.deepEqual(got.err, ["oops"]);
  });

  it("answers exit 1 with a plain message when the command cannot start", async () => {
    const cli = createCliRun({ entry: [], cwd: "/nonexistent-dir-for-test", env: {} });
    const got = await capture(cli, ["modules", "list"]);
    assert.equal(got.code, 1);
    assert.ok(got.err.join("\n").length > 0);
  });

  it("stops a command that runs too long and says so", async () => {
    const got = await capture(run("setTimeout(() => {}, 60000)", { timeoutMs: 150 }), ["x"]);
    assert.equal(got.code, 1);
    assert.match(got.err.join("\n"), /timed out/i);
  });

  it("caps what a command may print", async () => {
    const got = await capture(run("process.stdout.write('x'.repeat(5000))", { maxBytes: 1000 }), ["x"]);
    assert.equal(got.code, 1);
    assert.match(got.err.join("\n"), /too much output/i);
    assert.ok(got.out.join("\n").length <= 1000);
  });

  it("does not hand the child the parent's environment beyond what it was given", async () => {
    const got = await capture(run("console.log(Object.keys(process.env).includes('MNX_SECRET_PROBE'))"), ["x"]);
    assert.equal(got.out.join("\n"), "false");
  });
  it("stops the processes the command started too, not only the command", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-cli-"));
    const marker = join(dir, "grandchild-ran");
    try {
      const script = `require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'x'), 700)", ${JSON.stringify(marker)}], { stdio: "ignore" }); setTimeout(() => {}, 60000)`;
      const got = await capture(run(script, { timeoutMs: 150 }), ["x"]);
      assert.equal(got.code, 1);
      await new Promise((resolve) => setTimeout(resolve, 1200));
      assert.equal(existsSync(marker), false, "a process started by the command outlived the timeout");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the child process environment", () => {
  it("keeps what the CLI needs and drops everything else", () => {
    const env = allowedChildEnv({
      PATH: "/usr/bin", HOME: "/home/x", NODE_ENV: "production", DATABASE_URL: "postgres://db", MODUNEXO_MASTER_KEY: "k", MODUNEXO_DATA_DIR: "/data", MODUNEXO_DIST_DIR: "/dist", LOG_FORMAT: "json",
      MODUNEXO_MCP_WRITE: "1", AWS_SECRET_ACCESS_KEY: "s", GITHUB_TOKEN: "t", BETTER_AUTH_SECRET: "a", SMTP_PASSWORD: "p",
    });
    assert.deepEqual(Object.keys(env).sort(), ["DATABASE_URL", "HOME", "LOG_FORMAT", "MODUNEXO_DATA_DIR", "MODUNEXO_DIST_DIR", "MODUNEXO_MASTER_KEY", "NODE_ENV", "PATH"]);
  });

  it("omits a variable that is not set instead of passing undefined", () => {
    assert.deepEqual(allowedChildEnv({ PATH: "/usr/bin" }), { PATH: "/usr/bin" });
  });
});
