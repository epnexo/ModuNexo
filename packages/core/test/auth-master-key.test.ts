import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MASTER_KEY_ENV, MasterKeyError, deriveSecret, resolveMasterKey } from "../src/auth/master-key.ts";

const KEY = "k".repeat(32);

describe("resolveMasterKey", () => {
  it("returns the key from the environment", () => {
    assert.equal(resolveMasterKey({ [MASTER_KEY_ENV]: KEY }), KEY);
  });

  it("refuses a missing key and names the variable", () => {
    assert.throws(
      () => resolveMasterKey({}),
      (error: unknown) => error instanceof MasterKeyError && error.message.includes("EPNEXO_MASTER_KEY") && error.message.includes("not set"),
    );
  });

  it("refuses an empty or blank key as missing", () => {
    for (const value of ["", "   "]) {
      assert.throws(() => resolveMasterKey({ [MASTER_KEY_ENV]: value }), MasterKeyError);
    }
  });

  it("refuses a key shorter than 32 characters without echoing it", () => {
    const short = "s3cret-value-that-is-short";
    assert.throws(
      () => resolveMasterKey({ [MASTER_KEY_ENV]: short }),
      (error: unknown) => error instanceof MasterKeyError && error.message.includes("at least 32 characters") && !error.message.includes(short),
    );
  });

  it("does not count surrounding whitespace toward the length", () => {
    assert.throws(() => resolveMasterKey({ [MASTER_KEY_ENV]: ` ${"k".repeat(31)} ` }), MasterKeyError);
  });
});

describe("deriveSecret", () => {
  it("is deterministic for the same key and purpose", () => {
    assert.equal(deriveSecret(KEY, "auth"), deriveSecret(KEY, "auth"));
  });

  it("returns 64 hexadecimal characters", () => {
    assert.match(deriveSecret(KEY, "auth"), /^[0-9a-f]{64}$/);
  });

  it("gives a different secret per purpose and per key", () => {
    assert.notEqual(deriveSecret(KEY, "auth"), deriveSecret(KEY, "settings"));
    assert.notEqual(deriveSecret(KEY, "auth"), deriveSecret("j".repeat(32), "auth"));
  });

  it("never returns the master key itself", () => {
    assert.ok(!deriveSecret(KEY, "auth").includes(KEY));
  });

  it("refuses an empty purpose", () => {
    assert.throws(() => deriveSecret(KEY, ""), /purpose/);
  });
});
