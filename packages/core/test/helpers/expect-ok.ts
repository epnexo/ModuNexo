import assert from "node:assert/strict";

interface CliOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs a CLI command a test needs for its setup and asserts it exited 0. A bare `assert.equal(code, 0)` reports only
 * "1 !== 0" and drops the output, so an intermittent failure leaves nothing to diagnose; this keeps the command and
 * what it printed in the failure.
 */
export async function expectOk(cli: (args: string[]) => Promise<CliOutcome>, args: string[]): Promise<CliOutcome> {
  const outcome = await cli(args);
  assert.equal(outcome.code, 0, `"${args.join(" ")}" exited ${outcome.code}\nstderr: ${outcome.stderr}\nstdout: ${outcome.stdout}`);
  return outcome;
}
