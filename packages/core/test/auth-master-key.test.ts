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
      (error: unknown) => error instanceof MasterKeyError && error.message.includes("MODUNEXO_MASTER_KEY") && error.message.includes("not set"),
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

describe("the project rename", () => {
  it("accepts MODUNEXO_MASTER_KEY, and the old EPNEXO_MASTER_KEY as an alias", () => {
    assert.equal(resolveMasterKey({ MODUNEXO_MASTER_KEY: KEY }), KEY);
    assert.equal(resolveMasterKey({ EPNEXO_MASTER_KEY: KEY }), KEY);
  });

  it("prefers the new name when both are set, and falls back when the new one is blank", () => {
    const other = "o".repeat(40);
    assert.equal(resolveMasterKey({ MODUNEXO_MASTER_KEY: KEY, EPNEXO_MASTER_KEY: other }), KEY);
    assert.equal(resolveMasterKey({ MODUNEXO_MASTER_KEY: "  ", EPNEXO_MASTER_KEY: other }), other);
  });

  it("names the new variable when the key is missing, and says the old name still works", () => {
    assert.throws(
      () => resolveMasterKey({}),
      (error: unknown) => error instanceof MasterKeyError && error.message.includes("MODUNEXO_MASTER_KEY") && error.message.includes("EPNEXO_MASTER_KEY"),
    );
  });

  it("names the variable that supplied a too-short key, the old one included", () => {
    assert.throws(() => resolveMasterKey({ EPNEXO_MASTER_KEY: "short" }), /^MasterKeyError: EPNEXO_MASTER_KEY must be at least 32/);
    assert.throws(() => resolveMasterKey({ MODUNEXO_MASTER_KEY: "short" }), /^MasterKeyError: MODUNEXO_MASTER_KEY must be at least 32/);
  });

  // Secrets already stored are encrypted under keys derived with these exact inputs: the derivation must never change
  // with the project's name, or every stored secret stops decrypting and every session ends.
  it("derives exactly the same secrets as before the rename (stored secrets must still decrypt)", () => {
    assert.equal(deriveSecret(KEY, "auth"), "79ad81822ce6654ff6fffec3eec281cf947b61b4424f1657e660578b401c44b8");
    assert.equal(deriveSecret(KEY, "settings"), "5b296b1f3a163d1ce236a0723872a38cd59b87e99ca965fcb40b15321ad1790a");
  });
});
