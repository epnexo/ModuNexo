import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AlertRow } from "../src/server/dashboard.ts";
import { AUTO_REFRESH_MS, barAnimation, filterAlerts, severityCounts, shouldAutoRefresh, updatedLabel, valueAnimation } from "../src/server/dashboard-live.ts";

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
