import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCliRun } from "../src/server/mcp-cli.ts";

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
});
