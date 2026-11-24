import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { satisfies } from "semver";
import { ACTION_RISKS, ManifestError, SDK_VERSION, validateManifest } from "../src/index.ts";

const base = {
  id: "crm",
  version: "1.0.0",
  name: "CRM",
  platform: "^0.1.0",
  dependsOn: {},
  schema: "crm",
  migrationsDir: "migrations",
  nav: [],
  permissions: [{ key: "crm.read", label: "Read" }, { key: "crm.write", label: "Write" }],
  jobs: [{ name: "add_note", entry: "./jobs/add-note.ts" }, { name: "close_deal", entry: "./jobs/close-deal.ts" }],
};
const find = {
  key: "find_contact",
  label: "Find a contact",
  description: "Look a contact up by part of the name.",
  risk: "read",
  permission: "crm.read",
  input: { name: { type: "text", maxLength: 80, required: true } },
  sql: "select id, name from contacts where name ilike '%' || $1 || '%' order by name limit 20",
};
const note = {
  key: "add_note",
  label: "Add a note",
  description: "Adds a note to a contact.",
  risk: "write",
  permission: "crm.write",
  input: { contact: { type: "int", min: 1, max: 2147483647, required: true }, text: { type: "text", maxLength: 500, required: true } },
  job: "add_note",
};
const withActions = (actions: unknown, extra: Record<string, unknown> = {}) => ({ ...base, ...extra, actions });

const problemsOf = (input: unknown): string[] => {
  try {
    validateManifest(input);
  } catch (error) {
    assert.ok(error instanceof ManifestError);
    return error.problems;
  }
  return [];
};
const actionProblems = (action: Record<string, unknown>) => problemsOf(withActions([action])).filter((problem) => /^actions\[0\]/.test(problem));

describe("validateManifest: actions", () => {
  it("accepts a read and a write action together, and a module with none is as it was", () => {
    assert.deepEqual(problemsOf(withActions([find, note])), []);
    assert.deepEqual(problemsOf({ ...base }), []);
    assert.deepEqual([...ACTION_RISKS], ["read", "write", "sensitive"]);
  });

  it("accepts a sensitive action that runs a job, and an action that takes nothing", () => {
    const close = { key: "close_deal", label: "Close a deal", description: "Marks a deal as won.", risk: "sensitive", permission: "crm.write", job: "close_deal" };
    assert.deepEqual(problemsOf(withActions([close])), []);
    assert.deepEqual(problemsOf(withActions([{ ...find, input: undefined, sql: "select count(*)::int as contacts from contacts" }])), []);
  });

  it("must be a list, of at most twenty, each an object", () => {
    assert.match(problemsOf(withActions("nope")).join("\n"), /actions must be an array/);
    assert.match(problemsOf(withActions([42])).join("\n"), /actions\[0\] must be an object/);
    const many = Array.from({ length: 21 }, (_, i) => ({ ...find, key: `find_${i}` }));
    assert.match(problemsOf(withActions(many)).join("\n"), /at most 20/);
  });

  it("holds an action to the rules of a stable entry: known fields, a key, a label and a description", () => {
    assert.match(actionProblems({ ...find, secret: 1 }).join("\n"), /unknown field "secret"/);
    assert.match(actionProblems({ ...find, key: "Find Contact" }).join("\n"), /key must be a stable identifier/);
    assert.match(problemsOf(withActions([find, { ...note, key: "find_contact" }])).join("\n"), /key "find_contact" is duplicated/);
    assert.match(actionProblems({ ...find, label: "" }).join("\n"), /label must be a non-empty string/);
    assert.match(actionProblems({ ...find, label: "x".repeat(81) }).join("\n"), /label must be a non-empty string of at most 80/);
    assert.match(actionProblems({ ...find, description: "" }).join("\n"), /description must be a non-empty string of at most 300/);
    assert.match(actionProblems({ ...find, description: "x".repeat(301) }).join("\n"), /description must be a non-empty string of at most 300/);
  });

  it("needs a risk of the closed list, and a permission the module declares, for every action, reads included", () => {
    for (const risk of ["", "high", "READ", undefined, 3]) assert.match(actionProblems({ ...find, risk }).join("\n"), /risk must be one of read, write, sensitive/, String(risk));
    assert.match(actionProblems({ ...find, permission: undefined }).join("\n"), /permission must be the key of a permission declared in "permissions"/);
    assert.match(actionProblems({ ...find, permission: "crm.other" }).join("\n"), /permission must be the key of a permission declared in "permissions"/);
    assert.match(problemsOf(withActions([find], { permissions: undefined })).join("\n"), /permission must be the key of a permission declared/);
  });

  it("makes a read action one read-only statement and nothing else", () => {
    assert.match(actionProblems({ ...find, sql: undefined }).join("\n"), /read action needs "sql"/);
    assert.match(actionProblems({ ...find, job: "add_note" }).join("\n"), /read action cannot name a "job"/);
    assert.match(actionProblems({ ...find, sql: "delete from contacts" }).join("\n"), /sql must be one select \(or with\) statement with no ";"/);
    assert.match(actionProblems({ ...find, sql: "select 1; select 2" }).join("\n"), /sql must be one select \(or with\) statement with no ";"/);
    assert.match(actionProblems({ ...find, sql: "select 1 " + " ".repeat(2000) + "from contacts" }).join("\n"), /sql must be at most 2000 characters/);
  });

  it("binds the inputs to $1, $2 in the order they are declared, and refuses a placeholder with no input behind it", () => {
    assert.deepEqual(actionProblems({ ...find, sql: "select id from contacts where name = $1 and id > $2", input: { name: { type: "text", maxLength: 80 }, after: { type: "int", min: 0, max: 9 } } }), []);
    assert.match(actionProblems({ ...find, sql: "select id from contacts where name = $1 and id > $2" }).join("\n"), /sql uses \$2 but the action declares 1 input/);
    assert.match(actionProblems({ ...find, sql: "select 1", input: undefined }).join("\n"), /^$/, "a statement that uses no input is fine");
    assert.match(actionProblems({ ...find, sql: "select id from contacts where id = $0" }).join("\n"), /\$0/);
  });

  it("makes a write or sensitive action name a job of the module, and refuses a statement", () => {
    for (const risk of ["write", "sensitive"]) {
      assert.match(actionProblems({ ...note, risk, job: undefined }).join("\n"), new RegExp(`${risk} action needs "job"`));
      assert.match(actionProblems({ ...note, risk, job: "nope" }).join("\n"), /job "nope" is not a job this module declares/);
      assert.match(actionProblems({ ...note, risk, sql: "select 1" }).join("\n"), new RegExp(`${risk} action cannot name an "sql"`));
    }
    assert.match(problemsOf(withActions([note], { jobs: undefined })).join("\n"), /job "add_note" is not a job this module declares/);
  });

  it("describes each input with a closed set of kinds, never a free object", () => {
    const bad = (input: unknown) => actionProblems({ ...note, input }).join("\n");
    assert.match(bad({ Contact: { type: "int", min: 1, max: 9 } }), /input name "Contact" must be lowercase letters, digits and underscores/);
    assert.match(bad({ x: { type: "object" } }), /input "x" type must be one of text, int, enum, boolean/);
    assert.match(bad({ x: { type: "text" } }), /input "x" maxLength must be an integer from 1 to 2000/);
    assert.match(bad({ x: { type: "text", maxLength: 5000 } }), /maxLength must be an integer from 1 to 2000/);
    assert.match(bad({ x: { type: "int", min: 5, max: 1 } }), /min cannot be above max/);
    assert.match(bad({ x: { type: "int", min: 1.5, max: 9 } }), /min and max must be integers/);
    assert.match(bad({ x: { type: "enum", values: [] } }), /values must be a list of 1 to 20 distinct non-empty strings/);
    assert.match(bad({ x: { type: "enum", values: ["a", "a"] } }), /distinct/);
    assert.match(bad({ x: { type: "boolean", extra: 1 } }), /input "x" has unknown field "extra"/);
    assert.match(bad({ x: { type: "boolean", required: "yes" } }), /required must be true or false/);
    assert.match(bad([]), /input must be an object/);
    assert.deepEqual(actionProblems({ ...note, input: { flag: { type: "boolean" }, kind: { type: "enum", values: ["a", "b"], required: true } } }), []);
    const wide = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`f${i}`, { type: "boolean" }]));
    assert.match(bad(wide), /at most 12 inputs/);
  });

  it("is in the SDK version that introduced it", () => {
    assert.ok(satisfies(SDK_VERSION, ">=0.1.5"), SDK_VERSION);
  });
});
