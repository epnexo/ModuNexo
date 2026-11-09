import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { initialsOf as fromBrand } from "../src/settings/brand.ts";
import { initialsOf } from "../src/settings/brand-profile.ts";

test("initialsOf lives in a module that is safe to ship to the browser and brand re-exports the same function", () => {
  assert.equal(initialsOf("Ada Lovelace"), "AL");
  assert.equal(fromBrand, initialsOf);
});

test("brand-profile imports no Node module, so a client component that uses it does not bundle a crypto polyfill", () => {
  const source = readFileSync(new URL("../src/settings/brand-profile.ts", import.meta.url), "utf8");
  assert.equal(/from\s+["']node:/.test(source), false);
});
