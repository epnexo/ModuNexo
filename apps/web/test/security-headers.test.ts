import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match.js";
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
  const everyHeader = securityHeaders(false);
  const withoutPolicy = everyHeader.filter((header) => header.key !== "Content-Security-Policy");

  it("gives every page the full set, and the two paths that send a policy of their own the same set without the content policy", () => {
    const [everything, downloads, logo, ...rest] = headerRules(false);
    assert.deepEqual(rest, [], "three rules and no more");
    assert.deepEqual(everything!.headers, everyHeader);
    assert.deepEqual([downloads!.source, logo!.source], ["/api/files/:path*", "/api/brand/logo"]);
    for (const rule of [downloads!, logo!]) {
      assert.deepEqual(rule.headers, withoutPolicy);
      assert.ok(rule.headers.some((header) => header.key === "X-Frame-Options"), `${rule.source} is still not frameable`);
      assert.ok(rule.headers.some((header) => header.key === "X-Content-Type-Options"), `${rule.source} is still nosniff`);
    }
  });

  it("keeps the HTTPS-only header on every rule when the app is served over https", () => {
    for (const rule of headerRules(true)) assert.ok(rule.headers.some((header) => header.key === "Strict-Transport-Security"), rule.source);
  });

  // Next matches a rule's source with its own path matcher; ask it, so a pattern that only looks right cannot pass.
  it("matches exactly one rule for each path, by Next's own matcher", () => {
    const match = (source: string, path: string) => getPathMatch(source, { removeUnnamedParams: true, strict: true })(path) !== false;
    const rules = headerRules(false);
    const ruleFor = (path: string) => rules.filter((rule) => match(rule.source, path)).map((rule) => rule.source);
    for (const path of ["/", "/login", "/apps", "/settings/brand", "/api/health", "/api/events", "/api/auth/get-session", "/api/brand", "/api/brand/logos", "/api/brand/logo/x", "/api/filesystem", "/api/files-x", "/apps/api/files/x", "/a/b/c/d"]) {
      assert.equal(ruleFor(path).length, 1, `${path}: ${ruleFor(path).join(" | ")}`);
      assert.equal(match(rules[0]!.source, path), true, `${path} is a page path`);
    }
    for (const [path, source] of [["/api/files/m/i", "/api/files/:path*"], ["/api/files/m", "/api/files/:path*"], ["/api/brand/logo", "/api/brand/logo"]] as const) {
      assert.deepEqual(ruleFor(path), [source], path);
    }
  });
});
