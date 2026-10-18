import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { servedOverHttpsWithoutPublicUrl } from "../src/server/public-url-warning.ts";

const headers = (init: Record<string, string>) => new Headers(init);
const unset = { baseURL: undefined, secureCookies: false };
const https = { baseURL: "https://modunexo.example.com", secureCookies: true };

describe("servedOverHttpsWithoutPublicUrl", () => {
  it("is true when a proxy says the request was HTTPS and WEB_PUBLIC_URL is not an https origin", () => {
    assert.equal(servedOverHttpsWithoutPublicUrl(headers({ "x-forwarded-proto": "https" }), unset), true);
    assert.equal(servedOverHttpsWithoutPublicUrl(headers({ "x-forwarded-proto": "https, http" }), unset), true);
    assert.equal(servedOverHttpsWithoutPublicUrl(headers({ "x-forwarded-proto": "https" }), { baseURL: "http://192.168.1.20:3000", secureCookies: false }), true);
  });

  it("is true when the browser's Origin is https and WEB_PUBLIC_URL is not an https origin", () => {
    assert.equal(servedOverHttpsWithoutPublicUrl(headers({ origin: "https://modunexo.example.com" }), unset), true);
  });

  it("is false once WEB_PUBLIC_URL is an https origin", () => {
    assert.equal(servedOverHttpsWithoutPublicUrl(headers({ "x-forwarded-proto": "https", origin: "https://modunexo.example.com" }), https), false);
  });

  it("is false for plain HTTP, which is the supported local setup", () => {
    assert.equal(servedOverHttpsWithoutPublicUrl(headers({ "x-forwarded-proto": "http" }), unset), false);
    assert.equal(servedOverHttpsWithoutPublicUrl(headers({ origin: "http://192.168.1.20:3000" }), unset), false);
    assert.equal(servedOverHttpsWithoutPublicUrl(headers({}), unset), false);
  });
});
