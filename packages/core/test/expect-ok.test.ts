import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { expectOk } from "./helpers/expect-ok.ts";

describe("expectOk", () => {
  it("returns the outcome of a command that exited 0", async () => {
    const outcome = await expectOk(async () => ({ code: 0, stdout: "fine", stderr: "" }), ["db:migrate"]);
    assert.equal(outcome.stdout, "fine");
  });

  it("fails with the command, the exit code and what it printed", async () => {
    await assert.rejects(
      expectOk(async () => ({ code: 1, stdout: "partial", stderr: "boom: role already exists" }), ["modules", "install", "alpha"]),
      (error: Error) => {
        assert.match(error.message, /"modules install alpha" exited 1/);
        assert.match(error.message, /stderr: boom: role already exists/);
        assert.match(error.message, /stdout: partial/);
        return true;
      },
    );
  });
});
