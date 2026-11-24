import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { satisfies } from "semver";
import { CHART_LABEL_PLACEHOLDER, ManifestError, SDK_VERSION, chartBarHref, validateManifest } from "../src/index.ts";

const base = { id: "usage", version: "1.0.0", name: "Usage", platform: "^0.1.0", dependsOn: {}, schema: "usage", migrationsDir: "migrations", nav: [] };
const chart = { key: "tokens_by_day", label: "Tokens per day", href: "/usage", sql: "select to_char(day, 'DD Mon'), total from daily order by day" };
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

describe("validateManifest: dashboard charts", () => {
  it("accepts a chart on its own and next to stats", () => {
    assert.deepEqual(problemsOf(withDashboard({ charts: [chart] })), []);
    assert.deepEqual(problemsOf(withDashboard({ stats: [{ key: "n", label: "N", href: "/usage", sql: "select 1" }], charts: [chart] })), []);
  });

  it("keeps a manifest without charts valid and a dashboard still needs something to show", () => {
    assert.deepEqual(problemsOf(withDashboard({ stats: [{ key: "n", label: "N", href: "/usage", sql: "select 1" }] })), []);
    assert.match(problemsOf(withDashboard({ charts: [] }))[0] ?? "", /dashboard must declare at least one stat, alert or chart/);
  });

  it("holds a chart to the rules of a stat: stable key, label, local href, one read statement, declared permission", () => {
    assert.match(problemsOf(withDashboard({ charts: [{ ...chart, key: "Bad Key" }] })).join("\n"), /dashboard\.charts\[0\]\.key must be a stable identifier/);
    assert.match(problemsOf(withDashboard({ charts: [{ ...chart, href: "https://example.test" }] })).join("\n"), /dashboard\.charts\[0\]\.href must start with "\/"/);
    assert.match(problemsOf(withDashboard({ charts: [{ ...chart, sql: "delete from daily" }] })).join("\n"), /dashboard\.charts\[0\]\.sql must be one select/);
    assert.match(problemsOf(withDashboard({ charts: [{ ...chart, sql: "select 1; select 2" }] })).join("\n"), /dashboard\.charts\[0\]\.sql must be one select/);
    assert.match(problemsOf(withDashboard({ charts: [{ ...chart, permission: "usage.read" }] })).join("\n"), /dashboard\.charts\[0\]\.permission must be the key of a permission declared/);
    assert.match(problemsOf(withDashboard({ charts: [{ ...chart, severity: "error" }] })).join("\n"), /dashboard\.charts\[0\] has unknown field "severity"/);
    assert.match(problemsOf(withDashboard({ charts: [chart, chart] })).join("\n"), /dashboard\.charts\[1\]\.key "tokens_by_day" is duplicated/);
  });

  it("allows at most four charts, so the dashboard stays readable", () => {
    const five = Array.from({ length: 5 }, (_, i) => ({ ...chart, key: `c${i}` }));
    assert.match(problemsOf(withDashboard({ charts: five })).join("\n"), /dashboard\.charts must have at most 4 entries/);
  });

  it("raises the contract version, because an older platform refuses the new field", () => {
    assert.ok(satisfies(SDK_VERSION, ">=0.1.2"), `the SDK is ${SDK_VERSION}`);
  });
});

describe("validateManifest: a chart's href with the bar's label", () => {
  const hrefProblems = (href: string) => problemsOf(withDashboard({ charts: [{ ...chart, href }] })).filter((problem) => /href/.test(problem));

  it("accepts the label of the bar once, in the query string", () => {
    for (const href of ["/usage?day={label}", "/usage/by-day?tool=claude&day={label}&period=30d", "/usage?{label}"]) assert.deepEqual(hrefProblems(href), [], href);
    assert.equal(CHART_LABEL_PLACEHOLDER, "{label}");
  });

  it("refuses it in the path, twice, or with any other braces, and still refuses a way off the platform", () => {
    for (const href of ["/usage/{label}", "/{label}?a=1", "/usage?a={label}&b={label}", "/usage?a={tool}", "/usage?a={label", "/usage?a=label}", "/usage?a={{label}}", "//evil.example?a={label}", "https://evil.example/?a={label}", "/usage?a={label} b"]) {
      assert.equal(hrefProblems(href).length, 1, `${href} is refused`);
    }
  });

  it("keeps a stat's and an alert's href as it was: the label belongs to a bar", () => {
    assert.deepEqual(problemsOf(withDashboard({ stats: [{ key: "n", label: "N", href: "/usage", sql: "select 1" }] })), []);
  });

  it("is in the SDK version that introduced it, which a module asks for in its platform range", () => {
    assert.ok(satisfies(SDK_VERSION, ">=0.1.4"), SDK_VERSION);
  });
});

describe("chartBarHref", () => {
  it("puts the bar's label in the place the declaration named, encoded so it can only ever be one value of the query", () => {
    assert.equal(chartBarHref("/usage?day={label}", "23 Nov"), "/usage?day=23%20Nov");
    assert.equal(chartBarHref("/usage?tool=a&day={label}&x=1", "a&b=c/d?e#f"), "/usage?tool=a&day=a%26b%3Dc%2Fd%3Fe%23f&x=1");
    assert.equal(chartBarHref("/usage?day={label}", "100%"), "/usage?day=100%25");
  });

  it("leaves a link with no placeholder as it was, and never expands what the label itself says", () => {
    assert.equal(chartBarHref("/usage", "23 Nov"), "/usage");
    assert.equal(chartBarHref("/usage?day={label}", "{label}"), "/usage?day=%7Blabel%7D");
    assert.equal(chartBarHref("/usage?day={label}", "$& $1 $$"), "/usage?day=%24%26%20%241%20%24%24");
  });
});
