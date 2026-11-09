import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pickModule } from "../src/server/module-picker.ts";

const ENABLED = [
  { id: "agenda", name: "Agenda" },
  { id: "contacts", name: "Contacts" },
  { id: "documents", name: "Documents" },
];

describe("pickModule", () => {
  it("returns the module that was asked for", () => {
    assert.equal(pickModule(ENABLED, "contacts"), "contacts");
  });

  it("falls back to the first module when none is asked for", () => {
    assert.equal(pickModule(ENABLED, undefined), "agenda");
  });

  it("never selects a module that is not enabled, whatever the address says", () => {
    // A disabled or invented id must not reach the settings service: it falls back instead of being described.
    assert.equal(pickModule(ENABLED, "observability"), "agenda");
    assert.equal(pickModule(ENABLED, "../etc/passwd"), "agenda");
    assert.equal(pickModule(ENABLED, "__proto__"), "agenda");
  });

  it("takes the first value when the parameter is repeated", () => {
    assert.equal(pickModule(ENABLED, ["documents", "agenda"]), "documents");
  });

  it("answers null when no module is enabled", () => {
    assert.equal(pickModule([], "agenda"), null);
  });
});
