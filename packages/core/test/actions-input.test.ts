import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ActionDeclaration } from "@modunexo/sdk";
import { checkActionInput } from "../src/actions/input.ts";

const action = (input: ActionDeclaration["input"]): ActionDeclaration => ({ key: "a", label: "A", description: "D", risk: "write", permission: "m.write", job: "j", input });
const ok = (decl: ActionDeclaration, raw: unknown) => {
  const result = checkActionInput(decl, raw);
  assert.ok(result.ok, result.ok ? "" : result.message);
  return result;
};
const refused = (decl: ActionDeclaration, raw: unknown, message: RegExp) => {
  const result = checkActionInput(decl, raw);
  assert.equal(result.ok, false, JSON.stringify(raw));
  if (!result.ok) assert.match(result.message, message);
};

describe("checkActionInput", () => {
  const full = action({
    name: { type: "text", maxLength: 10, required: true },
    count: { type: "int", min: 1, max: 5 },
    kind: { type: "enum", values: ["a", "b"] },
    flag: { type: "boolean" },
  });

  it("returns the values as an object and in the order the inputs were declared, for the statement's $1, $2", () => {
    const result = ok(full, { kind: "b", name: "Ada", count: 3, flag: true });
    assert.deepEqual(result.values, { name: "Ada", count: 3, kind: "b", flag: true });
    assert.deepEqual(result.ordered, ["Ada", 3, "b", true]);
  });

  it("gives null to what was left out and is not required, and takes no input at all when none is declared", () => {
    const result = ok(full, { name: "Ada" });
    assert.deepEqual(result.values, { name: "Ada" });
    assert.deepEqual(result.ordered, ["Ada", null, null, null]);
    assert.deepEqual(ok(action(undefined), undefined).ordered, []);
    assert.deepEqual(ok(action(undefined), {}).values, {});
  });

  it("refuses what is not an object, an input nobody declared, and a missing required one", () => {
    refused(full, [], /the input must be an object/);
    refused(full, "x", /the input must be an object/);
    refused(full, null, /the input must be an object/);
    refused(full, { name: "Ada", other: 1 }, /unknown input "other"/);
    refused(full, {}, /"name" is required/);
    refused(full, { name: null }, /"name" is required/);
    refused(action(undefined), { x: 1 }, /unknown input "x"/);
  });

  it("holds each kind to its own bounds", () => {
    refused(full, { name: 5 }, /"name" must be text/);
    refused(full, { name: "x".repeat(11) }, /"name" must be at most 10 characters/);
    refused(full, { name: "" }, /"name" is required/);
    refused(full, { name: "a", count: 0 }, /"count" must be a whole number from 1 to 5/);
    refused(full, { name: "a", count: 6 }, /"count" must be a whole number from 1 to 5/);
    refused(full, { name: "a", count: 2.5 }, /"count" must be a whole number/);
    refused(full, { name: "a", count: "3" }, /"count" must be a whole number/);
    refused(full, { name: "a", kind: "c" }, /"kind" must be one of a, b/);
    refused(full, { name: "a", flag: "yes" }, /"flag" must be true or false/);
  });

  it("refuses text the database or a job could not store, and a value that is trying to be an object", () => {
    refused(full, { name: "a\u0000b" }, /"name" holds a character that cannot be stored/);
    refused(full, { name: "ab\ud800" }, /"name" holds a character that cannot be stored/);
    refused(full, { name: { $ne: 1 } }, /"name" must be text/);
    refused(full, { count: { valueOf: 1 }, name: "a" }, /"count" must be a whole number/);
  });

  it("never lets a prototype key through as an input", () => {
    refused(full, JSON.parse('{"name":"a","__proto__":{"x":1}}'), /unknown input "__proto__"/);
    refused(full, JSON.parse('{"name":"a","constructor":1}'), /unknown input "constructor"/);
  });
});
