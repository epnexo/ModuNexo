import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildChecksView, readCheckAnswer } from "../src/server/connection-checks.ts";

describe("buildChecksView", () => {
  it("lists the checks a module declares, as plain strings, in the order declared", () => {
    const view = buildChecksView({ checks: [{ key: "engine", label: "Test the engine", description: "Renders a page.", path: "/docs/test-engine" }, { key: "mail", label: "Test mail", path: "/docs/test-mail" }] });
    assert.deepEqual(view, [
      { key: "engine", label: "Test the engine", description: "Renders a page.", path: "/docs/test-engine" },
      { key: "mail", label: "Test mail", description: null, path: "/docs/test-mail" },
    ]);
  });

  it("is empty for a module without checks", () => {
    assert.deepEqual(buildChecksView({}), []);
    assert.deepEqual(buildChecksView({ checks: [] }), []);
  });
});

describe("readCheckAnswer", () => {
  it("shows the module's own message, in the success tone only for ok on a 2xx answer", () => {
    assert.deepEqual(readCheckAnswer(200, { ok: true, message: "Connected." }), { ok: true, message: "Connected." });
    assert.deepEqual(readCheckAnswer(200, { ok: false, message: "Token refused." }), { ok: false, message: "Token refused." });
    assert.deepEqual(readCheckAnswer(500, { ok: true, message: "Connected." }), { ok: false, message: "Connected." });
  });

  it("explains a refused session and an answer that is not the contract, without repeating what the route sent", () => {
    assert.match(readCheckAnswer(403, { error: "x" }).message, /session cannot run this check/);
    for (const body of [null, "ok", {}, { ok: "yes", message: "x" }, { ok: true }, { ok: true, message: 5 }]) {
      const outcome = readCheckAnswer(200, body);
      assert.equal(outcome.ok, false);
      assert.match(outcome.message, /did not answer as expected \(200\)/);
    }
  });

  it("keeps the message to one short plain line", () => {
    const outcome = readCheckAnswer(200, { ok: true, message: `Line one\n\u0007line two ${"x".repeat(400)}` });
    assert.ok(outcome.message.length <= 300);
    assert.doesNotMatch(outcome.message, /[\u0000-\u001f]/);
    assert.match(outcome.message, /^Line one line two/);
  });
});
