import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type AccessInput, decideAccess } from "../src/server/access.ts";
import { isPublicRoute, permissionRules, publicRouteRules, requiredPermissions } from "../src/server/route-permissions.ts";

const signed = { signature: { secret: "webhook_secret", header: "x-signature" } };
const inbox = {
  pages: [
    { path: "/hooks/inbox/messages", public: signed },
    { path: "/hooks/inbox/channels/[channel]", public: signed },
    { path: "/inbox", permission: "inbox.read" },
  ],
  nav: [{ href: "/inbox", permission: "inbox.read" }],
};
const rules = publicRouteRules([inbox]);

describe("publicRouteRules", () => {
  it("collects only the pages that declare themselves public", () => {
    assert.deepEqual(rules, [["hooks", "inbox", "messages"], ["hooks", "inbox", "channels", "[channel]"]]);
  });

  it("ignores a public declaration outside /hooks, so a bad manifest cannot open an ordinary path", () => {
    assert.deepEqual(publicRouteRules([{ pages: [{ path: "/inbox/export", public: signed }, { path: "/api/open", public: signed }, { path: "/", public: signed }] }]), []);
  });

  it("leaves permission rules alone", () => {
    assert.deepEqual(requiredPermissions("/inbox", permissionRules([inbox])), ["inbox.read"]);
  });
});

describe("publicRouteRules: scoped routes", () => {
  const svc = { pages: [{ path: "/svc/inbox/messages", scope: "messages.read" }, { path: "/svc/inbox/items/[id]", scope: "messages.read" }] };

  it("collects scoped pages under /svc, next to the signed ones under /hooks", () => {
    assert.deepEqual(publicRouteRules([inbox, svc]), [
      ["hooks", "inbox", "messages"],
      ["hooks", "inbox", "channels", "[channel]"],
      ["svc", "inbox", "messages"],
      ["svc", "inbox", "items", "[id]"],
    ]);
  });

  it("does not let a scoped page open a path outside /svc, nor a signed one outside /hooks", () => {
    assert.deepEqual(publicRouteRules([{ pages: [{ path: "/hooks/inbox/x", scope: "a.b" }, { path: "/svc/inbox/x", public: signed }, { path: "/inbox", scope: "a.b" }, { path: "/svc", scope: "a.b" }] }]), []);
  });

  it("applies the same all-readings rule to a scoped route", () => {
    const rules = publicRouteRules([svc]);
    assert.equal(isPublicRoute("/svc/inbox/messages", rules), true);
    assert.equal(isPublicRoute("/svc/inbox/items/42", rules), true);
    for (const path of ["/svc", "/svc/inbox", "/svc/other/messages", "/svc/inbox/items/..%2F..%2Fsettings", "/svc/inbox/items/%2e%2e", "/svc/inbox/messages/extra", "/hooks/inbox/messages"]) {
      assert.equal(isPublicRoute(path, rules), false, path);
    }
  });
});

describe("isPublicRoute", () => {
  it("is true for a declared path, with or without a trailing slash", () => {
    assert.equal(isPublicRoute("/hooks/inbox/messages", rules), true);
    assert.equal(isPublicRoute("/hooks/inbox/messages/", rules), true);
  });

  it("follows a dynamic segment", () => {
    assert.equal(isPublicRoute("/hooks/inbox/channels/whatsapp", rules), true);
    assert.equal(isPublicRoute("/hooks/inbox/channels", rules), false);
    assert.equal(isPublicRoute("/hooks/inbox/channels/a/b", rules), false);
  });

  it("is false for anything not declared", () => {
    for (const path of ["/", "/inbox", "/hooks", "/hooks/inbox", "/hooks/inbox/other", "/hooks/other/messages", "/hooks/inbox/messages/extra", "/api/health", "/settings"]) {
      assert.equal(isPublicRoute(path, rules), false, path);
    }
  });

  it("is false when nothing is declared", () => {
    assert.equal(isPublicRoute("/hooks/inbox/messages", []), false);
  });

  it("is false when any reading of the path leaves the declared route", () => {
    for (const path of [
      "/hooks/inbox/channels/..%2F..%2Fsettings",
      "/hooks/inbox/channels/%2e%2e%2f%2e%2e%2fsettings",
      "/hooks/inbox/channels/%252e%252e%252fsettings",
      "/hooks/inbox/channels/%2e%2e",
      "/hooks/inbox/channels/..",
      "/hooks/inbox/channels/a%2Fb",
      "/hooks/inbox/messages/%2e%2e/%2e%2e/settings",
    ]) {
      assert.equal(isPublicRoute(path, rules), false, path);
    }
  });

  it("does not trust an encoded form that only decodes into a declared path", () => {
    assert.equal(isPublicRoute("/hooks%2Finbox%2Fmessages", rules), false);
  });

  it("reads a malformed escape as written instead of throwing", () => {
    assert.equal(isPublicRoute("/hooks/inbox/channels/%E0%A4%A", rules), true, "a segment that cannot be decoded stays as written and is still one segment");
    assert.equal(isPublicRoute("/hooks/inbox/messages%", rules), false);
  });
});

const input = (overrides: Partial<AccessInput> = {}): AccessInput => ({
  pathname: "/hooks/inbox/messages",
  mode: "required",
  hasSession: false,
  local: false,
  hostOk: false,
  permitted: true,
  ...overrides,
});

describe("decideAccess: public routes", () => {
  it("lets a public route in without a session while sign-in is required", () => {
    assert.deepEqual(decideAccess(input({ publicRoute: true })), { action: "allow" });
  });

  it("still sends the same path to sign in when it is not a declared public route", () => {
    assert.deepEqual(decideAccess(input({ publicRoute: false })), { action: "redirect", to: "/login" });
    assert.deepEqual(decideAccess(input()), { action: "redirect", to: "/login" });
  });

  it("keeps every other path closed even when a public route exists", () => {
    assert.deepEqual(decideAccess(input({ pathname: "/api/other", publicRoute: false })), { action: "deny", status: 401, message: "Sign-in required" });
    assert.deepEqual(decideAccess(input({ pathname: "/inbox", publicRoute: false })), { action: "redirect", to: "/login" });
  });

  it("does not open a public route while sign-in is disabled and the caller is not local", () => {
    assert.deepEqual(decideAccess(input({ mode: "disabled", publicRoute: true })), { action: "deny", status: 403, message: "Forbidden" });
  });

  it("serves a local caller of a public route while sign-in is disabled", () => {
    assert.deepEqual(decideAccess(input({ mode: "disabled", local: true, hostOk: true, publicRoute: true })), { action: "allow" });
  });
});
