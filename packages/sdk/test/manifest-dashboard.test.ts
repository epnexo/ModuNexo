import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ManifestError, validateManifest } from "../src/index.ts";

const base = {
  id: "contacts",
  version: "1.0.0",
  name: "Contacts",
  platform: "^0.1.0",
  dependsOn: {},
  schema: "contacts",
  migrationsDir: "migrations",
  nav: [],
};

const stat = { key: "open_leads", label: "Open leads", href: "/pipeline", sql: "select count(*)::int from leads" };
const alert = { key: "stale", label: "Leads not moved", href: "/pipeline", severity: "warning", sql: "select count(*)::int from leads" };
const withDashboard = (dashboard: unknown) => ({ ...base, dashboard });

const problemsOf = (input: unknown): string[] => {
  try {
    validateManifest(input);
  } catch (error) {
    assert.ok(error instanceof ManifestError);
    return error.problems;
  }
  return [];
};

describe("validateManifest: dashboard", () => {
  it("keeps a manifest without a dashboard valid", () => {
    assert.deepEqual(problemsOf(base), []);
  });

  it("accepts stats, alerts, or both", () => {
    assert.deepEqual(problemsOf(withDashboard({ stats: [stat] })), []);
    assert.deepEqual(problemsOf(withDashboard({ alerts: [alert] })), []);
    assert.deepEqual(problemsOf(withDashboard({ stats: [stat], alerts: [alert] })), []);
  });

  it("refuses a dashboard that is not an object, is empty, or has unknown fields", () => {
    assert.match(problemsOf(withDashboard([]))[0] ?? "", /dashboard must be an object/);
    assert.match(problemsOf(withDashboard({}))[0] ?? "", /dashboard must declare at least one stat or alert/);
    assert.match(problemsOf(withDashboard({ stats: [], alerts: [] }))[0] ?? "", /dashboard must declare at least one stat or alert/);
    assert.match(problemsOf(withDashboard({ stats: [stat], widgets: [] })).join("\n"), /dashboard has unknown field "widgets"/);
  });

  it("refuses an entry with a bad key, a repeated key, an empty or long label, or an href that does not start with /", () => {
    assert.match(problemsOf(withDashboard({ stats: [{ ...stat, key: "Open Leads" }] })).join("\n"), /dashboard\.stats\[0\]\.key/);
    assert.match(problemsOf(withDashboard({ stats: [stat, stat] })).join("\n"), /dashboard\.stats\[1\]\.key "open_leads" is duplicated/);
    assert.match(problemsOf(withDashboard({ stats: [{ ...stat, label: "" }] })).join("\n"), /dashboard\.stats\[0\]\.label/);
    assert.match(problemsOf(withDashboard({ stats: [{ ...stat, label: "x".repeat(81) }] })).join("\n"), /dashboard\.stats\[0\]\.label/);
    assert.match(problemsOf(withDashboard({ stats: [{ ...stat, href: "pipeline" }] })).join("\n"), /dashboard\.stats\[0\]\.href must start with "\/"/);
    assert.match(problemsOf(withDashboard({ stats: [{ ...stat, href: "//evil.example" }] })).join("\n"), /dashboard\.stats\[0\]\.href/);
    // A browser reads "/\\host" as "//host", so a backslash, a space or a control character cannot be in an address.
    for (const href of ["/\\evil.example", "/ pipeline", "/a\tb", "/a\\b", "/\nx", "/a\u0000b", "/a\u0001b", "/a\u007fb", "/a\u200bb", "/a\ufeffb"]) {
      assert.match(problemsOf(withDashboard({ alerts: [{ ...alert, href }] })).join("\n"), /dashboard\.alerts\[0\]\.href/, JSON.stringify(href));
    }
    for (const href of ["/", "/pipeline", "/agenda/settings", "/inbox?unread=1"]) assert.deepEqual(problemsOf(withDashboard({ stats: [{ ...stat, href }] })), [], href);
  });

  it("refuses an alert whose severity is not info, warning or error", () => {
    for (const severity of ["info", "warning", "error"]) assert.deepEqual(problemsOf(withDashboard({ alerts: [{ ...alert, severity }] })), []);
    assert.match(problemsOf(withDashboard({ alerts: [{ ...alert, severity: "fatal" }] })).join("\n"), /dashboard\.alerts\[0\]\.severity must be one of info, warning, error/);
    assert.match(problemsOf(withDashboard({ alerts: [{ ...alert, severity: undefined }] })).join("\n"), /dashboard\.alerts\[0\]\.severity/);
  });

  it("refuses a stat that carries a severity, since only alerts have one", () => {
    assert.match(problemsOf(withDashboard({ stats: [{ ...stat, severity: "info" }] })).join("\n"), /dashboard\.stats\[0\] has unknown field "severity"/);
  });

  it("accepts only one SELECT or WITH statement as the sql", () => {
    assert.deepEqual(problemsOf(withDashboard({ stats: [{ ...stat, sql: "  WITH x AS (select 1) select count(*) from x" }] })), []);
    for (const sql of ["delete from leads", "update leads set title = 'x'", "select 1; select 2", "select 1;", "", "   ", 7]) {
      assert.match(problemsOf(withDashboard({ stats: [{ ...stat, sql }] })).join("\n"), /dashboard\.stats\[0\]\.sql/, String(sql));
    }
  });

  it("limits the sql length and the number of entries", () => {
    assert.match(problemsOf(withDashboard({ stats: [{ ...stat, sql: `select ${"1,".repeat(1500)}1` }] })).join("\n"), /dashboard\.stats\[0\]\.sql must be at most 2000 characters/);
    const many = Array.from({ length: 13 }, (_, i) => ({ ...stat, key: `s${i}` }));
    assert.match(problemsOf(withDashboard({ stats: many })).join("\n"), /dashboard\.stats must have at most 12 entries/);
  });

  it("hides a card behind a declared permission, and refuses one that is not declared", () => {
    const declared = { ...base, permissions: [{ key: "contacts.read", label: "Read" }] };
    assert.deepEqual(problemsOf({ ...declared, dashboard: { stats: [{ ...stat, permission: "contacts.read" }], alerts: [{ ...alert, permission: "contacts.read" }] } }), []);
    assert.match(problemsOf({ ...declared, dashboard: { stats: [{ ...stat, permission: "contacts.write" }] } }).join("\n"), /dashboard\.stats\[0\]\.permission must be the key of a permission declared/);
    assert.match(problemsOf(withDashboard({ alerts: [{ ...alert, permission: "contacts.read" }] })).join("\n"), /dashboard\.alerts\[0\]\.permission/);
  });
});
