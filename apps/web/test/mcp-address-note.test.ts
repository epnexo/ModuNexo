import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addressNote } from "../src/server/mcp-address-note.ts";

describe("addressNote", () => {
  it("warns only when the address was taken from the request's Host header, and says how to fix it", () => {
    const note = addressNote("request");
    assert.ok(note !== null);
    assert.match(note, /Host header/);
    assert.match(note, /API access/);
    assert.match(note, /WEB_PUBLIC_URL/);
  });

  it("says nothing for an address someone chose", () => {
    for (const source of ["saved", "public-url", "none"] as const) assert.equal(addressNote(source), null, source);
  });
});
