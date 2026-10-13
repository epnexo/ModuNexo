import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { SETTINGS_READER, type SettingsReader, SettingsUnavailableError, getSetting } from "../src/settings.ts";

const store = globalThis as typeof globalThis & { [SETTINGS_READER]?: SettingsReader };
afterEach(() => {
  delete store[SETTINGS_READER];
});

describe("getSetting", () => {
  it("asks the reader the platform registered, with the module and the key", async () => {
    const calls: [string, string][] = [];
    store[SETTINGS_READER] = {
      get: async (moduleId, key) => {
        calls.push([moduleId, key]);
        return 50;
      },
    };
    assert.equal(await getSetting("alpha", "page.size"), 50);
    assert.deepEqual(calls, [["alpha", "page.size"]]);
  });

  it("returns null when the setting has no value and no default", async () => {
    store[SETTINGS_READER] = { get: async () => null };
    assert.equal(await getSetting("alpha", "note"), null);
  });

  it("says plainly that settings are only available inside the platform when no reader is registered", async () => {
    await assert.rejects(getSetting("alpha", "page.size"), (error: unknown) => error instanceof SettingsUnavailableError && /platform/.test(error.message));
  });

  it("passes the reader's own error through, so an unreadable secret is not hidden", async () => {
    store[SETTINGS_READER] = {
      get: async () => {
        throw new Error('the secret "api.token" of module "alpha" cannot be read');
      },
    };
    await assert.rejects(getSetting("alpha", "api.token"), /cannot be read/);
  });

  it("is the same reader across module copies: it is found through a global symbol, not an import", () => {
    assert.equal(SETTINGS_READER, Symbol.for("epnexo.settings.reader"));
  });
});
