import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SecretUnreadableError, decryptSecret, encryptSecret } from "../src/settings/crypto.ts";

const KEY = "k".repeat(40);
const OTHER_KEY = "j".repeat(40);
const SLOT = { moduleId: "alpha", key: "api.token" };

describe("encryptSecret and decryptSecret", () => {
  it("round trips a value, including non-ASCII text and a long one", () => {
    for (const value of ["s3cret", "contraseña ñandú 🔑", "x".repeat(4000), " leading and trailing  "]) {
      assert.equal(decryptSecret(KEY, SLOT, encryptSecret(KEY, SLOT, value)), value);
    }
  });

  it("produces a different token each time, in a versioned format, without the plaintext in it", () => {
    const first = encryptSecret(KEY, SLOT, "hunter2-hunter2");
    const second = encryptSecret(KEY, SLOT, "hunter2-hunter2");
    assert.notEqual(first, second);
    assert.match(first, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.ok(!first.includes("hunter2"));
  });

  it("is unreadable under another master key", () => {
    const token = encryptSecret(KEY, SLOT, "value");
    assert.throws(() => decryptSecret(OTHER_KEY, SLOT, token), SecretUnreadableError);
  });

  it("is bound to its module and key: a token moved to another slot is unreadable", () => {
    const token = encryptSecret(KEY, SLOT, "value");
    assert.throws(() => decryptSecret(KEY, { moduleId: "beta", key: "api.token" }, token), SecretUnreadableError);
    assert.throws(() => decryptSecret(KEY, { moduleId: "alpha", key: "other.key" }, token), SecretUnreadableError);
  });

  it("is unreadable when any part of the token was changed or the token is malformed", () => {
    const token = encryptSecret(KEY, SLOT, "value");
    const [version, iv, tag, data] = token.split(".") as [string, string, string, string];
    const flip = (part: string) => `${part.slice(0, -2)}${part.endsWith("AA") ? "BB" : "AA"}`;
    for (const broken of [
      `${version}.${flip(iv)}.${tag}.${data}`,
      `${version}.${iv}.${flip(tag)}.${data}`,
      `${version}.${iv}.${tag}.${flip(data)}`,
      `v2.${iv}.${tag}.${data}`,
      `${version}.${iv}.${tag}`,
      "",
      "not a token",
    ]) {
      assert.throws(() => decryptSecret(KEY, SLOT, broken), SecretUnreadableError, broken);
    }
  });

  it("never puts the master key or the plaintext in an error", () => {
    try {
      decryptSecret(OTHER_KEY, SLOT, encryptSecret(KEY, SLOT, "plain-secret-value"));
      assert.fail("should have thrown");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assert.ok(!message.includes("plain-secret-value") && !message.includes(KEY) && !message.includes(OTHER_KEY));
      assert.match(message, /alpha/);
      assert.match(message, /api\.token/);
    }
  });
});
