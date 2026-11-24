import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NextRequest } from "next/server";
import { SAFE_MODE_COOKIE, safeModeChange, safeModeRedirect } from "../src/server/safe-mode.ts";

const request = (path: string) => new NextRequest(`https://crm.example.test${path}`);

describe("safeModeChange", () => {
  it("reads ?nocss=1 as on and ?nocss=0 as off, and nothing else as a change", () => {
    assert.equal(safeModeChange(new URLSearchParams("nocss=1")), "on");
    assert.equal(safeModeChange(new URLSearchParams("nocss=0")), "off");
    for (const query of ["", "nocss", "nocss=", "nocss=2", "nocss=true", "other=1"]) assert.equal(safeModeChange(new URLSearchParams(query)), null, query);
  });
});

describe("safeModeRedirect", () => {
  it("sets the cookie for the session and goes to the same page without the parameter, keeping the rest of the query", () => {
    const response = safeModeRedirect(request("/settings?tab=appearance&nocss=1"), "on");
    assert.equal(response.status, 307);
    assert.equal(response.headers.get("location"), "https://crm.example.test/settings?tab=appearance");
    const cookie = response.cookies.get(SAFE_MODE_COOKIE);
    assert.equal(cookie?.value, "1");
    assert.equal(cookie?.maxAge, undefined, "a session cookie");
    assert.equal(cookie?.sameSite, "lax");
    assert.equal(cookie?.path, "/");
  });

  it("clears the cookie when turned off", () => {
    const response = safeModeRedirect(request("/login?nocss=0"), "off");
    assert.equal(response.headers.get("location"), "https://crm.example.test/login");
    const cookie = response.cookies.get(SAFE_MODE_COOKIE);
    assert.equal(cookie?.value, "");
    assert.equal(cookie?.maxAge, 0);
  });

  it("is never cached", () => {
    assert.equal(safeModeRedirect(request("/?nocss=1"), "on").headers.get("cache-control"), "no-store");
  });
});
