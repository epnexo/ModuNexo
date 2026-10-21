import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { headerRules, securityHeaders } from "../src/server/security-headers.ts";

const asMap = (headers: { key: string; value: string }[]) => new Map(headers.map((header) => [header.key.toLowerCase(), header.value]));

describe("securityHeaders", () => {
  it("forbids framing, sniffing and leaking the referrer", () => {
    const headers = asMap(securityHeaders(false));
    assert.equal(headers.get("x-frame-options"), "DENY");
    assert.equal(headers.get("x-content-type-options"), "nosniff");
    assert.equal(headers.get("referrer-policy"), "same-origin");
    assert.match(headers.get("permissions-policy") ?? "", /camera=\(\)/);
  });

  it("sets a CSP that blocks framing, plugins and foreign forms, and leaves scripts alone", () => {
    const csp = asMap(securityHeaders(false)).get("content-security-policy") ?? "";
    for (const directive of ["frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'"]) assert.ok(csp.includes(directive), directive);
    assert.ok(!csp.includes("script-src"), "the app has inline scripts, so no script-src");
    assert.ok(!csp.includes("default-src"), "no default-src: it would restrict scripts and styles too");
  });

  it("sends HSTS only when the app is served over https", () => {
    assert.equal(asMap(securityHeaders(false)).has("strict-transport-security"), false);
    assert.match(asMap(securityHeaders(true)).get("strict-transport-security") ?? "", /^max-age=\d+/);
  });
});

describe("headerRules", () => {
  it("gives every page the full set, and the file downloads the same set without the content policy, which the download sets itself", () => {
    const [everything, downloads] = headerRules(false);
    assert.deepEqual(everything!.headers, securityHeaders(false));
    assert.equal(downloads!.source, "/api/files/:path*");
    assert.deepEqual(downloads!.headers, securityHeaders(false).filter((header) => header.key !== "Content-Security-Policy"));
    assert.ok(downloads!.headers.some((header) => header.key === "X-Frame-Options"), "it is still not frameable");
  });

  it("keeps the first rule off the downloads, so the two never both write the policy", () => {
    const [everything] = headerRules(true);
    assert.match(everything!.source, /api\/files/, "the first rule names what it leaves out");
    assert.ok(everything!.headers.some((header) => header.key === "Strict-Transport-Security"));
  });
});
