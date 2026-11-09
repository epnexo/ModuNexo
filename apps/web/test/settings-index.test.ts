import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GENERAL_SETTINGS, buildSettingsIndex, searchSettings } from "../src/server/settings-index.ts";

const MODULES = [
  { id: "documents", name: "Documents", settings: [
    { key: "signing_url", label: "Signing service address", type: "string", description: "Where documents are sent to be signed.", default: "https://sign.example.test" },
    { key: "signing_token", label: "Signing token", type: "secret", description: "Stored encrypted; never shown again.", required: true },
  ] },
  { id: "agenda", name: "Agenda", settings: [{ key: "slot", label: "Slot length", type: "number", default: 30 }] },
  { id: "observability", name: "Observability", settings: [{ key: "collector", label: "Collector address", type: "string" }] },
  { id: "empty", name: "No settings" },
];
const ENABLED = new Set(["documents", "agenda", "empty"]);

describe("buildSettingsIndex", () => {
  it("lists the settings of the enabled modules only, with a link to the module that owns them", () => {
    const index = buildSettingsIndex(MODULES, ENABLED);
    assert.deepEqual(index.map((entry) => entry.label), [...GENERAL_SETTINGS.map((g) => g.label), "Signing service address", "Signing token", "Slot length"]);
    const token = index.find((entry) => entry.label === "Signing token")!;
    assert.equal(token.href, "/settings?module=documents#modules");
    assert.equal(token.where, "Documents");
  });

  it("never carries a value: no default, no key, nothing a secret could leak through", () => {
    const text = JSON.stringify(buildSettingsIndex(MODULES, ENABLED));
    assert.doesNotMatch(text, /sign\.example\.test|signing_token|"default"|"key"/);
  });

  it("encodes a module id in the link", () => {
    const odd = [{ id: "a&b", name: "Odd", settings: [{ key: "x", label: "X", type: "string" }] }];
    const [entry] = buildSettingsIndex(odd, new Set(["a&b"])).filter((e) => e.where === "Odd");
    assert.equal(entry!.href, "/settings?module=a%26b#modules");
  });
});

describe("searchSettings", () => {
  const index = buildSettingsIndex(MODULES, ENABLED);

  it("matches the label, the help text and the module name, without regard to case", () => {
    assert.deepEqual(searchSettings(index, "TOKEN").map((e) => e.label), ["Signing token"]);
    assert.deepEqual(searchSettings(index, "sent to be signed").map((e) => e.label), ["Signing service address"]);
    assert.deepEqual(searchSettings(index, "agenda").map((e) => e.label), ["Slot length"]);
  });

  it("answers nothing for an empty or blank query, and caps the list", () => {
    assert.deepEqual(searchSettings(index, ""), []);
    assert.deepEqual(searchSettings(index, "   "), []);
    assert.equal(searchSettings(index, "e", 2).length, 2);
  });

  it("finds the general sections too", () => {
    assert.ok(searchSettings(index, "security").some((e) => e.where === "General" && e.href === "/settings#security"));
  });
});
