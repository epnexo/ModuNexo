import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type RunRow, isFinished, planAction, runSummary, stepLabel } from "../src/server/apps-flow.ts";

const run = (extra: Partial<RunRow> = {}): RunRow => ({
  id: 1,
  moduleId: "reports",
  version: "1.1.0",
  kind: "upgrade",
  status: "running",
  step: "build",
  detail: "next build (this takes a while)",
  actor: "admin@example.test",
  startedAt: "2026-10-14T10:00:00.000Z",
  finishedAt: null,
  ...extra,
});

describe("planAction", () => {
  it("is an install for a module that is not installed, and an upgrade for a newer version", () => {
    assert.deepEqual(planAction({ id: "reports", version: "1.0.0" }, undefined), { kind: "install", label: "Install reports 1.0.0", blocked: null });
    assert.deepEqual(planAction({ id: "reports", version: "1.1.0" }, "1.0.0"), { kind: "upgrade", label: "Upgrade reports 1.0.0 to 1.1.0", blocked: null });
  });

  it("is blocked, with the reason, for the same version or an older one", () => {
    assert.match(planAction({ id: "reports", version: "1.0.0" }, "1.0.0").blocked ?? "", /already installed/i);
    assert.match(planAction({ id: "reports", version: "0.9.0" }, "1.0.0").blocked ?? "", /older|newer/i);
  });
});

describe("run display", () => {
  it("summarises a run in progress with its step and what it is doing", () => {
    assert.equal(runSummary(run()), "Upgrading reports to 1.1.0: building the web app (next build (this takes a while))");
    assert.equal(runSummary(run({ kind: "install", step: "lifecycle", detail: null })), "Installing reports 1.1.0: running migrations and hooks");
  });

  it("summarises how a finished run ended", () => {
    assert.equal(runSummary(run({ status: "succeeded", step: "restart", detail: "restart requested from the web launcher (pid 1)" })), "Upgraded reports to 1.1.0. restart requested from the web launcher (pid 1)");
    assert.match(runSummary(run({ status: "rolled_back", detail: "build: the web build failed" })), /Rolled back.*build: the web build failed/);
    assert.match(runSummary(run({ status: "failed", detail: "interrupted: its process (9) is gone" })), /Failed.*interrupted/);
  });

  it("knows which statuses are final and names unknown steps plainly", () => {
    assert.equal(isFinished(run()), false);
    for (const status of ["succeeded", "failed", "rolled_back"] as const) assert.equal(isFinished(run({ status })), true);
    assert.equal(stepLabel("place"), "placing the package");
    assert.equal(stepLabel("something-new"), "something-new");
  });
});
