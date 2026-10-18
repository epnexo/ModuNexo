import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("@epnexo/sdk, the pre-rename name", () => {
  it("still resolves and is the very same SDK, so an old module builds and packs", async () => {
    const legacy = await import("@epnexo/sdk");
    const current = await import("@modunexo/sdk");
    assert.equal(legacy.defineModule, current.defineModule);
    assert.equal(legacy.SDK_VERSION, current.SDK_VERSION);
    assert.equal(legacy.getDb, current.getDb);
  });
});
