import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type AccessInput, decideAccess, isPublicPath } from "../src/server/access.ts";

const input = (overrides: Partial<AccessInput>): AccessInput => ({ pathname: "/", mode: "required", hasSession: false, local: true, hostOk: true, permitted: true, ...overrides });

describe("isPublicPath", () => {
  it("is true for the sign-in page and the auth endpoints only", () => {
    for (const path of ["/login", "/login/", "/api/auth", "/api/auth/sign-in/email", "/api/auth/get-session"]) assert.equal(isPublicPath(path), true, path);
    for (const path of ["/", "/apps", "/settings", "/api/authx", "/api/other", "/loginx", "/login/extra", "/LOGIN", "/a/login"]) assert.equal(isPublicPath(path), false, path);
  });
});

describe("decideAccess: sign-in required", () => {
  it("sends a visitor without a session to the sign-in page", () => {
    for (const pathname of ["/", "/apps", "/settings", "/anything/deep"]) {
      assert.deepEqual(decideAccess(input({ pathname })), { action: "redirect", to: "/login" }, pathname);
    }
  });

  it("answers an API call without a session with 401, not a redirect", () => {
    assert.deepEqual(decideAccess(input({ pathname: "/api/modules" })), { action: "deny", status: 401, message: "Sign-in required" });
    assert.deepEqual(decideAccess(input({ pathname: "/api/authx" })), { action: "deny", status: 401, message: "Sign-in required" });
  });

  it("lets the sign-in page and the auth endpoints through without a session", () => {
    assert.deepEqual(decideAccess(input({ pathname: "/login" })), { action: "allow" });
    assert.deepEqual(decideAccess(input({ pathname: "/api/auth/sign-in/email" })), { action: "allow" });
  });

  it("sends a signed-in visitor away from the sign-in page and lets everything else through", () => {
    assert.deepEqual(decideAccess(input({ pathname: "/login", hasSession: true })), { action: "redirect", to: "/" });
    for (const pathname of ["/", "/apps", "/api/modules", "/api/auth/get-session"]) {
      assert.deepEqual(decideAccess(input({ pathname, hasSession: true })), { action: "allow" }, pathname);
    }
  });

  it("does not depend on where the request comes from", () => {
    assert.deepEqual(decideAccess(input({ pathname: "/", hasSession: true, local: false })), { action: "allow" });
    assert.deepEqual(decideAccess(input({ pathname: "/", local: false })), { action: "redirect", to: "/login" });
  });
});

describe("decideAccess: sign-in disabled", () => {
  it("serves a local request without a session", () => {
    for (const pathname of ["/", "/apps", "/settings", "/api/modules", "/api/auth/get-session"]) {
      assert.deepEqual(decideAccess(input({ pathname, mode: "disabled" })), { action: "allow" }, pathname);
    }
  });

  it("has no sign-in page to show: a local visitor is sent to the home screen", () => {
    assert.deepEqual(decideAccess(input({ pathname: "/login", mode: "disabled" })), { action: "redirect", to: "/" });
  });

  it("refuses every request that is not local, the sign-in page and the auth endpoints included", () => {
    for (const pathname of ["/", "/apps", "/login", "/api/modules", "/api/auth/sign-in/email"]) {
      const decision = decideAccess(input({ pathname, mode: "disabled", local: false }));
      assert.deepEqual(decision, { action: "deny", status: 403, message: "Forbidden" }, pathname);
    }
  });

  it("refuses a non-local request even when it carries a session", () => {
    assert.deepEqual(decideAccess(input({ mode: "disabled", local: false, hasSession: true })), { action: "deny", status: 403, message: "Forbidden" });
  });

  it("refuses a local connection that names a public host: DNS rebinding, or a public proxy without forwarding headers", () => {
    for (const pathname of ["/", "/login", "/api/auth/get-session"]) {
      assert.deepEqual(decideAccess(input({ pathname, mode: "disabled", hostOk: false })), { action: "deny", status: 403, message: "Forbidden" }, pathname);
    }
  });

  it("does not look at the host while sign-in is required: the session cookie belongs to the host that set it", () => {
    assert.deepEqual(decideAccess(input({ pathname: "/", mode: "required", hasSession: true, hostOk: false })), { action: "allow" });
  });

  it("does not reveal the configuration in the refusal", () => {
    const decision = decideAccess(input({ mode: "disabled", local: false }));
    assert.ok(decision.action === "deny" && !/sign-in|disabled|auth|local/i.test(decision.message));
  });
});

describe("decideAccess: permissions", () => {
  it("refuses a signed-in visitor who does not hold the permission a path needs", () => {
    assert.deepEqual(decideAccess(input({ pathname: "/finance", hasSession: true, permitted: false })), { action: "deny", status: 403, message: "Forbidden" });
    assert.deepEqual(decideAccess(input({ pathname: "/api/finance/export", hasSession: true, permitted: false })), { action: "deny", status: 403, message: "Forbidden" });
  });

  it("serves one who holds it", () => {
    assert.deepEqual(decideAccess(input({ pathname: "/finance", hasSession: true, permitted: true })), { action: "allow" });
  });

  it("asks for a session first: a visitor without one is sent to sign in, not told about permissions", () => {
    assert.deepEqual(decideAccess(input({ pathname: "/finance", hasSession: false, permitted: false })), { action: "redirect", to: "/login" });
    assert.deepEqual(decideAccess(input({ pathname: "/api/finance", hasSession: false, permitted: false })), { action: "deny", status: 401, message: "Sign-in required" });
  });

  it("applies while sign-in is off too, so the rule does not depend on the mode", () => {
    assert.deepEqual(decideAccess(input({ pathname: "/finance", mode: "disabled", permitted: false })), { action: "deny", status: 403, message: "Forbidden" });
    assert.deepEqual(decideAccess(input({ pathname: "/finance", mode: "disabled", permitted: true })), { action: "allow" });
  });

  it("does not touch the sign-in page or the auth endpoints", () => {
    assert.deepEqual(decideAccess(input({ pathname: "/login", permitted: false })), { action: "allow" });
    assert.deepEqual(decideAccess(input({ pathname: "/api/auth/sign-in/email", permitted: false })), { action: "allow" });
  });
});
