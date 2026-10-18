import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { resolveDataDir } from "../src/packages/paths.ts";

describe("resolveDataDir", () => {
  it("uses MODUNEXO_DATA_DIR, and the old EPNEXO_DATA_DIR as an alias, the new name winning", () => {
    assert.equal(resolveDataDir({ MODUNEXO_DATA_DIR: "/srv/new" }), resolve("/srv/new"));
    assert.equal(resolveDataDir({ EPNEXO_DATA_DIR: "/srv/old" }), resolve("/srv/old"));
    assert.equal(resolveDataDir({ MODUNEXO_DATA_DIR: "/srv/new", EPNEXO_DATA_DIR: "/srv/old" }), resolve("/srv/new"));
  });

  it("falls back to var/ at the repository root when neither is set", () => {
    assert.match(resolveDataDir({}), /\/var$/);
  });
});
