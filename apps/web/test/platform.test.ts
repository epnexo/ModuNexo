import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { closePlatform, platform, reopenPlatform } from "../src/server/platform.ts";

const KEYS = ["EPNEXO_MASTER_KEY", "DATABASE_URL", "WEB_PUBLIC_URL"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  reopenPlatform();
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
});
afterEach(async () => {
  await closePlatform();
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("platform", () => {
  it("fails on a missing master key without leaving a pool behind, and keeps failing the same way", () => {
    delete process.env.EPNEXO_MASTER_KEY;
    process.env.DATABASE_URL = "postgres://u:p@127.0.0.1:1/none";
    assert.throws(() => platform(), /EPNEXO_MASTER_KEY/);
    assert.throws(() => platform(), /EPNEXO_MASTER_KEY/);
  });

  it("is created once and reused", () => {
    process.env.EPNEXO_MASTER_KEY = "p".repeat(40);
    process.env.DATABASE_URL = "postgres://u:p@127.0.0.1:1/none";
    delete process.env.WEB_PUBLIC_URL;
    assert.equal(platform(), platform());
  });

  it("refuses to be created again once it was closed, so a late request cannot open a pool nothing closes", async () => {
    process.env.EPNEXO_MASTER_KEY = "p".repeat(40);
    process.env.DATABASE_URL = "postgres://u:p@127.0.0.1:1/none";
    platform();
    await closePlatform();
    assert.throws(() => platform(), /shutting down/);
  });
});
