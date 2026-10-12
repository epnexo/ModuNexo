import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { quoteIdentifier } from "../src/sql.ts";

describe("quoteIdentifier", () => {
  it("quotes a valid lowercase identifier", () => {
    assert.equal(quoteIdentifier("sample_1"), '"sample_1"');
  });

  it("rejects anything that is not a plain lowercase identifier instead of escaping it", () => {
    for (const bad of ["", "Upper", '"; drop schema core; --', "a b", "a-b", "1abc", "a".repeat(64), "pg_catalog", "a.b"]) {
      assert.throws(() => quoteIdentifier(bad), /invalid SQL identifier/, bad);
    }
  });
});
