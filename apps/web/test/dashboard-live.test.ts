import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AlertRow } from "../src/server/dashboard.ts";
import { AUTO_REFRESH_MS, MODULE_SEARCH_FROM, barAnimation, barReadout, filterAlerts, filterModules, foldKey, stepBar, severityCounts, shouldAutoRefresh, updatedLabel, valueAnimation } from "../src/server/dashboard-live.ts";

const alert = (key: string, severity: AlertRow["severity"], source = "Platform"): AlertRow => ({ key, severity, source, label: key, detail: "", href: "/", when: null });
const ALERTS = [alert("a", "error"), alert("b", "warning", "Inbox"), alert("c", "warning"), alert("d", "info")];

describe("filterAlerts", () => {
  it("keeps every alert, in order, for 'all'", () => {
    assert.deepEqual(filterAlerts(ALERTS, "all").map((a) => a.key), ["a", "b", "c", "d"]);
  });
  it("keeps only the chosen severity", () => {
    assert.deepEqual(filterAlerts(ALERTS, "warning").map((a) => a.key), ["b", "c"]);
  });
  it("never invents or changes an alert", () => {
    assert.equal(filterAlerts(ALERTS, "error")[0], ALERTS[0]);
    assert.equal(ALERTS.length, 4);
  });
});

describe("severityCounts", () => {
  it("counts each severity and the total", () => {
    assert.deepEqual(severityCounts(ALERTS), { all: 4, error: 1, warning: 2, info: 1 });
  });
  it("is all zeros for no alerts", () => {
    assert.deepEqual(severityCounts([]), { all: 0, error: 0, warning: 0, info: 0 });
  });
});

describe("shouldAutoRefresh", () => {
  it("refreshes only when the switch is on and the tab is visible", () => {
    assert.equal(shouldAutoRefresh(true, "visible"), true);
    assert.equal(shouldAutoRefresh(true, "hidden"), false);
    assert.equal(shouldAutoRefresh(false, "visible"), false);
  });
  it("waits no less than 15 seconds between refreshes, so the page cannot hammer the server", () => {
    assert.ok(AUTO_REFRESH_MS >= 15_000);
  });
});

describe("updatedLabel", () => {
  const at = new Date("2026-11-10T09:05:07");
  it("says how long ago the figures were read", () => {
    assert.equal(updatedLabel(at, new Date("2026-11-10T09:05:09")), "Updated just now");
    assert.equal(updatedLabel(at, new Date("2026-11-10T09:05:47")), "Updated 40 s ago");
    assert.equal(updatedLabel(at, new Date("2026-11-10T09:08:07")), "Updated 3 min ago");
  });
});

describe("barAnimation", () => {
  it("grows each bar for 820 ms, 65 ms after the previous one, up to a delay of 585 ms", () => {
    assert.deepEqual([0, 1, 2].map((i) => barAnimation(i).delay), [0, 65, 130]);
    assert.equal(barAnimation(0).duration, 820);
    assert.equal(barAnimation(9).delay, 585);
    assert.equal(barAnimation(30).delay, 585);
  });
  it("shows the value after its bar has started", () => {
    assert.ok(valueAnimation(3).delay > barAnimation(3).delay);
  });
});

describe("barReadout", () => {
  it("says the label and value, and how far the bar is from the average", () => {
    assert.equal(barReadout("Tue 5", 1240, 1000), "Tue 5: 1,240 · 24% above the average");
    assert.equal(barReadout("Wed 6", 500, 1000), "Wed 6: 500 · 50% below the average");
    assert.equal(barReadout("Thu 7", 1000, 1000), "Thu 7: 1,000 · at the average");
  });

  it("gives only the label and value when there is no average to compare with", () => {
    assert.equal(barReadout("Tue 5", 1240, null), "Tue 5: 1,240");
    assert.equal(barReadout("Tue 5", 7, 0), "Tue 5: 7");
  });
});

describe("stepBar", () => {
  it("moves one bar with the arrows and to the ends with Home and End", () => {
    assert.equal(stepBar("ArrowRight", 2, 5), 3);
    assert.equal(stepBar("ArrowLeft", 2, 5), 1);
    assert.equal(stepBar("Home", 3, 5), 0);
    assert.equal(stepBar("End", 1, 5), 4);
  });

  it("stops at the ends instead of wrapping, and ignores any other key", () => {
    assert.equal(stepBar("ArrowRight", 4, 5), 4);
    assert.equal(stepBar("ArrowLeft", 0, 5), 0);
    assert.equal(stepBar("Enter", 2, 5), null);
    assert.equal(stepBar("ArrowRight", 0, 0), null);
  });
});

describe("filterModules", () => {
  const MODULES = [
    { name: "Contacts", stats: [{ label: "People" }] },
    { name: "Agenda", stats: [{ label: "Bookings this week" }] },
    { name: "AI usage", stats: [{ label: "Tokens, last 7 days" }] },
  ];

  it("keeps every module, in order, for blank text", () => {
    assert.deepEqual(filterModules(MODULES, "  ").map((m) => m.name), ["Contacts", "Agenda", "AI usage"]);
  });

  it("matches a module's name or the name of one of its figures, ignoring case", () => {
    assert.deepEqual(filterModules(MODULES, "agen").map((m) => m.name), ["Agenda"]);
    assert.deepEqual(filterModules(MODULES, "TOKENS").map((m) => m.name), ["AI usage"]);
    assert.deepEqual(filterModules(MODULES, "zzz"), []);
  });
});

describe("dashboard folds", () => {
  it("keeps one storage key per section and offers search only for more than a few modules", () => {
    assert.notEqual(foldKey("charts"), foldKey("figures"));
    assert.match(foldKey("charts"), /charts$/);
    assert.ok(MODULE_SEARCH_FROM >= 3);
  });
});
