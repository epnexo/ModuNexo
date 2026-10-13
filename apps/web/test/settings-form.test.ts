import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SettingDeclaration } from "@epnexo/sdk";
import { planModuleSettingsUpdate } from "../src/server/settings-form.ts";

const DECLARATIONS: SettingDeclaration[] = [
  { key: "site.title", label: "Site title", type: "string" },
  { key: "page.size", label: "Page size", type: "number" },
  { key: "feature.on", label: "Enabled", type: "boolean" },
  { key: "report.format", label: "Format", type: "select", options: ["pdf", "csv"] },
  { key: "api.token", label: "API token", type: "secret" },
];

const plan = (body: unknown) => planModuleSettingsUpdate(DECLARATIONS, body);
const operations = (body: unknown) => {
  const result = plan(body);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.ok ? result.operations : [];
};

describe("planModuleSettingsUpdate", () => {
  it("sets the fields it is given and leaves the others alone", () => {
    assert.deepEqual(operations({ values: { "site.title": "Hello", "page.size": "40" } }), [
      { op: "set", key: "site.title", value: "Hello" },
      { op: "set", key: "page.size", value: "40" },
    ]);
  });

  it("treats an empty or null non-secret value as clearing it", () => {
    assert.deepEqual(operations({ values: { "site.title": "", "page.size": null, "report.format": "" } }), [
      { op: "unset", key: "site.title" },
      { op: "unset", key: "page.size" },
      { op: "unset", key: "report.format" },
    ]);
  });

  it("passes a boolean through as a boolean, including false", () => {
    assert.deepEqual(operations({ values: { "feature.on": false } }), [{ op: "set", key: "feature.on", value: false }]);
  });

  it("keeps a secret that was left blank, replaces one that was typed, and clears only when asked", () => {
    assert.deepEqual(operations({ values: { "api.token": "" } }), []);
    assert.deepEqual(operations({ values: { "api.token": "new-value" } }), [{ op: "set", key: "api.token", value: "new-value" }]);
    assert.deepEqual(operations({ values: {}, clear: ["api.token"] }), [{ op: "unset", key: "api.token" }]);
  });

  it("lets an explicit clear win over a typed secret in the same request", () => {
    assert.deepEqual(operations({ values: { "api.token": "typed" }, clear: ["api.token"] }), [{ op: "unset", key: "api.token" }]);
  });

  it("refuses a key the module does not declare, in values or in clear, naming it", () => {
    for (const body of [{ values: { "not.declared": "x" } }, { values: {}, clear: ["not.declared"] }]) {
      const result = plan(body);
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.message, /not\.declared/);
    }
  });

  it("refuses a body of the wrong shape", () => {
    for (const body of [null, "text", 5, [], { values: "x" }, { values: [] }, { values: {}, clear: "api.token" }, { values: {}, clear: [1] }, { values: { "site.title": {} } }, {}]) {
      assert.equal(plan(body).ok, false, JSON.stringify(body));
    }
  });

  it("does not echo a typed secret in a refusal", () => {
    const result = plan({ values: { "api.token": "super-secret-value", "not.declared": "x" } });
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(!result.message.includes("super-secret-value"));
  });
});
