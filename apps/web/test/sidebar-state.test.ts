import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SIDEBAR_COOKIE, parseSidebar, sidebarCookie } from "../src/server/sidebar-state.ts";

describe("parseSidebar", () => {
  it("reads the two states that exist", () => {
    assert.equal(parseSidebar("rail"), "rail");
    assert.equal(parseSidebar("open"), "open");
  });

  it("is open when there is no cookie or it holds anything else", () => {
    // The cookie is a per-viewer convenience written by the browser: whatever it holds, the shell must still render.
    assert.equal(parseSidebar(undefined), "open");
    assert.equal(parseSidebar(""), "open");
    assert.equal(parseSidebar("hidden"), "open");
    assert.equal(parseSidebar("RAIL"), "open");
    assert.equal(parseSidebar('"><script>alert(1)</script>'), "open");
  });
});

describe("sidebarCookie", () => {
  it("writes a year-long, same-site cookie for the whole site, and Secure on https", () => {
    assert.equal(sidebarCookie("rail", false), `${SIDEBAR_COOKIE}=rail; Path=/; Max-Age=31536000; SameSite=Lax`);
    assert.equal(sidebarCookie("open", true), `${SIDEBAR_COOKIE}=open; Path=/; Max-Age=31536000; SameSite=Lax; Secure`);
  });
});
