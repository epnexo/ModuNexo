import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LaunchError, resolvePublicUrl } from "../src/server/launch.ts";

describe("resolvePublicUrl", () => {
  it("is unset by default: plain HTTP on the local network, cookies that work there", () => {
    assert.deepEqual(resolvePublicUrl({}), { baseURL: undefined, secureCookies: false });
    assert.deepEqual(resolvePublicUrl({ WEB_PUBLIC_URL: "  " }), { baseURL: undefined, secureCookies: false });
  });

  it("uses an http origin as given and keeps cookies usable over HTTP", () => {
    assert.deepEqual(resolvePublicUrl({ WEB_PUBLIC_URL: "http://192.168.1.20:3000" }), { baseURL: "http://192.168.1.20:3000", secureCookies: false });
  });

  it("marks cookies secure for an https origin and drops a trailing slash", () => {
    assert.deepEqual(resolvePublicUrl({ WEB_PUBLIC_URL: "https://epnexo.example.com/" }), { baseURL: "https://epnexo.example.com", secureCookies: true });
  });

  it("refuses anything that is not a bare http or https origin, naming the variable", () => {
    for (const value of ["epnexo.example.com", "ftp://x", "https://x/app", "https://x?y=1", "https://user:pw@x", "https://", "javascript:alert(1)"]) {
      assert.throws(
        () => resolvePublicUrl({ WEB_PUBLIC_URL: value }),
        (error: unknown) => error instanceof LaunchError && error.message.includes("WEB_PUBLIC_URL") && !error.message.includes("pw@"),
        value,
      );
    }
  });
});
