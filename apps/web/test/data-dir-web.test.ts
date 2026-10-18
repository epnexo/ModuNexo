import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { dataDir } from "../src/server/apps-deps.ts";

describe("the web app's data directory", () => {
  it("is the one the CLI uses: the new variable, its old name, else var/ at the root; the new name wins", () => {
    assert.equal(dataDir("/repo", { MODUNEXO_DATA_DIR: "/srv/new" }), resolve("/srv/new"));
    assert.equal(dataDir("/repo", { EPNEXO_DATA_DIR: "/srv/old" }), resolve("/srv/old"));
    assert.equal(dataDir("/repo", { MODUNEXO_DATA_DIR: "/srv/new", EPNEXO_DATA_DIR: "/srv/old" }), resolve("/srv/new"));
    assert.equal(dataDir("/repo", {}), join("/repo", "var"));
  });
});
