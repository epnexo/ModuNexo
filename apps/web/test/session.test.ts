import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sessionIsUsable } from "../src/server/session.ts";

const NOW = new Date("2026-10-13T12:00:00Z");

describe("sessionIsUsable", () => {
  it("accepts a user who was never banned", () => {
    assert.equal(sessionIsUsable({}, NOW), true);
    assert.equal(sessionIsUsable({ banned: null }, NOW), true);
    assert.equal(sessionIsUsable({ banned: false }, NOW), true);
  });

  it("refuses a banned user with no expiry", () => {
    assert.equal(sessionIsUsable({ banned: true }, NOW), false);
    assert.equal(sessionIsUsable({ banned: true, banExpires: null }, NOW), false);
  });

  it("refuses a banned user whose ban has not expired, as a date or as text", () => {
    assert.equal(sessionIsUsable({ banned: true, banExpires: new Date("2026-10-14T00:00:00Z") }, NOW), false);
    assert.equal(sessionIsUsable({ banned: true, banExpires: "2026-10-14T00:00:00Z" }, NOW), false);
  });

  it("accepts a user whose ban has expired", () => {
    assert.equal(sessionIsUsable({ banned: true, banExpires: new Date("2026-10-12T00:00:00Z") }, NOW), true);
    assert.equal(sessionIsUsable({ banned: true, banExpires: NOW }, NOW), true);
  });

  it("fails closed on an expiry it cannot read", () => {
    assert.equal(sessionIsUsable({ banned: true, banExpires: "not a date" }, NOW), false);
  });
});
