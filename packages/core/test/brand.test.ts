import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_IMAGE_BYTES, initialsOf, validateImage, validateProfile } from "../src/settings/brand.ts";

const business = { kind: "business", name: " Acme SAS ", representative: "Ana Ruiz", email: "ana@acme.co" };
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

describe("validateProfile", () => {
  it("accepts a business with its three required fields and trims them", () => {
    const checked = validateProfile(business);
    assert.deepEqual(checked, { ok: true, value: { kind: "business", name: "Acme SAS", representative: "Ana Ruiz", email: "ana@acme.co" } });
  });
  it("keeps the optional business fields it was given and drops empty ones", () => {
    const checked = validateProfile({ ...business, website: "https://acme.co", phone: "  ", taxId: "900.1", address: "Calle 1" });
    assert.deepEqual(checked.ok && checked.value, { kind: "business", name: "Acme SAS", representative: "Ana Ruiz", email: "ana@acme.co", website: "https://acme.co", taxId: "900.1", address: "Calle 1" });
  });
  for (const [label, patch, message] of [
    ["no name", { name: "" }, /business name is required/],
    ["no representative", { representative: undefined }, /legal representative is required/],
    ["no email", { email: " " }, /contact email is required/],
    ["a bad email", { email: "ana@" }, /not a valid address/],
    ["a website without a scheme", { website: "acme.co" }, /full http or https/],
    ["a javascript website", { website: "javascript:alert(1)" }, /full http or https/],
    ["a control character", { name: "Ac\u0000me" }, /control characters/],
    ["a long name", { name: "x".repeat(81) }, /longer than 80/],
  ] as const) {
    it(`refuses ${label}`, () => {
      const checked = validateProfile({ ...business, ...patch });
      assert.equal(checked.ok, false);
      assert.match(!checked.ok ? checked.message : "", message);
    });
  }
  it("accepts a person with a default monogram color and refuses a bad one", () => {
    assert.deepEqual(validateProfile({ kind: "personal", name: "Ana" }), { ok: true, value: { kind: "personal", name: "Ana", monogramHue: 250 } });
    assert.equal(validateProfile({ kind: "personal", name: "Ana", monogramHue: 400 }).ok, false);
    assert.equal(validateProfile({ kind: "personal", name: "Ana", monogramHue: 1.5 }).ok, false);
  });
  it("keeps a person's optional email, drops an empty one and refuses a bad one", () => {
    assert.deepEqual(validateProfile({ kind: "personal", name: "Ana", email: " ana@x.co " }), { ok: true, value: { kind: "personal", name: "Ana", monogramHue: 250, email: "ana@x.co" } });
    assert.deepEqual(validateProfile({ kind: "personal", name: "Ana", email: "" }), { ok: true, value: { kind: "personal", name: "Ana", monogramHue: 250 } });
    assert.equal(validateProfile({ kind: "personal", name: "Ana", email: "ana@" }).ok, false);
  });
  it("refuses an unknown kind and a non-object", () => {
    assert.equal(validateProfile({ kind: "team", name: "x" }).ok, false);
    assert.equal(validateProfile(null).ok, false);
    assert.equal(validateProfile([]).ok, false);
  });
});

describe("validateImage", () => {
  it("accepts a PNG by its bytes and returns its type and hash", () => {
    const checked = validateImage(png);
    assert.equal(checked.ok && checked.value.contentType, "image/png");
    assert.match(checked.ok ? checked.value.sha256 : "", /^[0-9a-f]{64}$/);
  });
  it("recognises JPEG and WebP", () => {
    assert.equal(validateImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])).ok, true);
    const webp = new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 ");
    assert.equal(validateImage(webp).ok && (validateImage(webp) as { value: { contentType: string } }).value.contentType, "image/webp");
  });
  it("refuses SVG, empty and oversized content whatever it claims to be", () => {
    assert.equal(validateImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')).ok, false);
    assert.equal(validateImage(new Uint8Array(0)).ok, false);
    const big = new Uint8Array(MAX_IMAGE_BYTES + 1);
    big.set(png);
    assert.match((validateImage(big) as { message: string }).message, /larger than 512 KB/);
  });
});

describe("initialsOf", () => {
  it("takes the first letters of the first and last words", () => {
    assert.equal(initialsOf("ana maria ruiz"), "AR");
    assert.equal(initialsOf("Acme"), "A");
    assert.equal(initialsOf("  "), "?");
  });
});
