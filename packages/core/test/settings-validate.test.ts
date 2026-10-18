import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SettingDeclaration } from "@modunexo/sdk";
import { validateSetting } from "../src/settings/validate.ts";

const decl = (overrides: Partial<SettingDeclaration>): SettingDeclaration => ({ key: "some.key", label: "Some key", type: "string", ...overrides });
const ok = (declaration: SettingDeclaration, input: unknown) => {
  const result = validateSetting(declaration, input);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.ok ? result.value : undefined;
};
const refused = (declaration: SettingDeclaration, input: unknown) => {
  const result = validateSetting(declaration, input);
  assert.equal(result.ok, false, `expected a refusal for ${JSON.stringify(input)}`);
  return result.ok ? "" : result.message;
};

describe("validateSetting: string", () => {
  it("accepts text as given", () => {
    assert.equal(ok(decl({}), "  hello  "), "  hello  ");
  });
  it("refuses an empty or blank value, a non-string, a NUL byte and a long one, naming the key", () => {
    for (const input of ["", "   ", 5, null, undefined, "a\u0000b", "x".repeat(2001)]) {
      assert.match(refused(decl({}), input), /some\.key/);
    }
  });
});

describe("validateSetting: number", () => {
  it("accepts a finite number or its decimal text", () => {
    const d = decl({ type: "number" });
    assert.equal(ok(d, 42), 42);
    assert.equal(ok(d, "42"), 42);
    assert.equal(ok(d, " -3.5 "), -3.5);
    assert.equal(ok(d, 0), 0);
  });
  it("refuses anything else, including the forms Number() would let through", () => {
    for (const input of ["", "abc", "1e3", "0x10", "Infinity", NaN, Infinity, "1,5", "5 5", true, null]) {
      assert.match(refused(decl({ type: "number" }), input), /some\.key/, String(input));
    }
  });
});

describe("validateSetting: boolean", () => {
  it("accepts a boolean or its text", () => {
    const d = decl({ type: "boolean" });
    assert.equal(ok(d, true), true);
    assert.equal(ok(d, false), false);
    assert.equal(ok(d, "true"), true);
    assert.equal(ok(d, "false"), false);
  });
  it("refuses everything else", () => {
    for (const input of ["yes", "1", 1, 0, "", null, "TRUE"]) refused(decl({ type: "boolean" }), input);
  });
});

describe("validateSetting: select", () => {
  const d = decl({ type: "select", options: ["a", "b"] });
  it("accepts a listed option", () => {
    assert.equal(ok(d, "a"), "a");
  });
  it("refuses an unlisted one and lists the allowed values", () => {
    const message = refused(d, "c");
    assert.match(message, /a/);
    assert.match(message, /b/);
    refused(d, "A");
    refused(d, "");
  });
});

describe("validateSetting: path", () => {
  const d = decl({ type: "path" });
  it("accepts an absolute path and trims it", () => {
    assert.equal(ok(d, "/var/lib/modunexo"), "/var/lib/modunexo");
    assert.equal(ok(d, "  /srv/data  "), "/srv/data");
  });
  it("refuses a relative path, parent segments, a NUL and a very long one", () => {
    for (const input of ["data", "./data", "/srv/../etc", "/srv/..", "", "/a\u0000b", `/${"x".repeat(1100)}`, 7]) refused(d, input);
  });
});

describe("validateSetting: secret", () => {
  const d = decl({ type: "secret" });
  it("accepts any non-empty text and does not trim it", () => {
    assert.equal(ok(d, " p@ss "), " p@ss ");
  });
  it("refuses an empty value, a non-string and a huge one, and never echoes the value", () => {
    for (const input of ["", 12, null, "x".repeat(4097), "a\u0000b"]) {
      const message = refused(d, input);
      assert.ok(!message.includes("x".repeat(20)));
    }
    assert.ok(!refused(d, "a\u0000b-super-secret").includes("super-secret"));
  });
});
