import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ModuleCards, PlatformOverview } from "@modunexo/core/dashboard";
import { buildDashboard } from "../src/server/dashboard.ts";

const NOW = new Date("2026-10-23T12:00:00Z");
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);

const cards = (over: Partial<ModuleCards> = {}): ModuleCards => ({ stats: [], alerts: [], silent: [], enabled: 0, ...over });
const overview = (over: Partial<PlatformOverview> = {}): PlatformOverview => ({ modules: { enabled: 2, disabled: 1 }, jobs: { queued: 0, running: 0 }, alerts: [], activity: [], ...over });
const alertCard = (over: Record<string, unknown> = {}) => ({ moduleId: "inbox", moduleName: "Inbox", key: "unanswered", label: "Unanswered conversations", href: "/inbox", severity: "warning" as const, count: 3, ...over });
const statCard = (over: Record<string, unknown> = {}) => ({ moduleId: "contacts", moduleName: "Contacts", key: "people", label: "People", href: "/contacts", value: 12 as number | string | null, ...over });

describe("buildDashboard: the headline", () => {
  it("says everything is fine when nothing needs attention, and counts what does otherwise", () => {
    assert.deepEqual(buildDashboard({ cards: cards(), overview: null, now: NOW }).headline, { tone: "ok", text: "Everything looks fine." });
    const one = buildDashboard({ cards: cards({ alerts: [alertCard()] }), overview: null, now: NOW }).headline;
    assert.deepEqual(one, { tone: "warning", text: "1 thing needs attention." });
    const two = buildDashboard({ cards: cards({ alerts: [alertCard(), alertCard({ key: "b", severity: "error" })] }), overview: null, now: NOW }).headline;
    assert.deepEqual(two, { tone: "error", text: "2 things need attention." });
  });
});

describe("buildDashboard: alerts", () => {
  it("puts the most serious first, and the platform's before a module's of the same severity", () => {
    const view = buildDashboard({
      cards: cards({ alerts: [alertCard({ key: "w", severity: "warning" }), alertCard({ key: "e", severity: "error", label: "Module error" }), alertCard({ key: "i", severity: "info" })] }),
      overview: overview({ alerts: [{ kind: "job_dead", severity: "error", moduleId: "inbox", label: 'Job "answer" of inbox stopped after its last attempt', href: "/status", count: 1, at: minutesAgo(5) }] }),
      now: NOW,
    });
    assert.deepEqual(view.alerts.map((alert) => alert.source), ["Platform", "Inbox", "Inbox", "Inbox"]);
    assert.deepEqual(view.alerts.map((alert) => alert.severity), ["error", "error", "warning", "info"]);
    assert.equal(view.alerts[0]!.href, "/status");
    assert.equal(view.alerts[0]!.when, "5 min ago");
  });

  it("shows the count of a module's alert, and says not available when it could not be counted", () => {
    const view = buildDashboard({ cards: cards({ alerts: [alertCard({ count: 3 }), alertCard({ key: "x", count: null })] }), overview: null, now: NOW });
    assert.deepEqual(view.alerts.map((alert) => alert.detail), ["3", "not available"]);
  });

  it("adds the worker line as a platform alert for an administrator, and leaves it out when there is none", () => {
    const line = "2 jobs have been due for 3 min and nobody has taken them.";
    const view = buildDashboard({ cards: cards(), overview: overview(), workerLine: line, now: NOW });
    assert.deepEqual(view.alerts.map((alert) => [alert.source, alert.label, alert.href]), [["Platform", line, "/status"]]);
    assert.equal(buildDashboard({ cards: cards(), overview: overview(), workerLine: null, now: NOW }).alerts.length, 0);
  });
});

describe("buildDashboard: figures, silent modules and the platform block", () => {
  it("groups the figures by module, shows a missing figure as not available and a number with separators", () => {
    const view = buildDashboard({
      cards: cards({ stats: [statCard({ value: 12345 }), statCard({ key: "x", label: "Other", value: null }), statCard({ moduleId: "agenda", moduleName: "Agenda", key: "today", label: "Today", href: "/agenda", value: "3 bookings" })] }),
      overview: null,
      now: NOW,
    });
    assert.deepEqual(view.modules.map((entry) => entry.name), ["Contacts", "Agenda"]);
    assert.deepEqual(view.modules[0]!.stats.map((stat) => [stat.label, stat.value, stat.href]), [["People", "12,345", "/contacts"], ["Other", "not available", "/contacts"]]);
    assert.equal(view.modules[1]!.stats[0]!.value, "3 bookings");
  });

  it("lists the modules that contribute nothing, by name", () => {
    const view = buildDashboard({ cards: cards({ silent: [{ moduleId: "hello", moduleName: "Hello" }] }), overview: null, now: NOW });
    assert.deepEqual(view.silent, ["Hello"]);
  });

  it("shows the platform block and the activity only when it is given an overview, with the time of each entry", () => {
    assert.equal(buildDashboard({ cards: cards(), overview: null, now: NOW }).platform, null);
    const view = buildDashboard({
      cards: cards(),
      overview: overview({ modules: { enabled: 3, disabled: 1 }, jobs: { queued: 2, running: 1 }, activity: [{ at: minutesAgo(2), moduleId: "inbox", text: "inbox.message.received", href: "/status" }] }),
      now: NOW,
    });
    assert.deepEqual(view.platform, { modules: "3 enabled, 1 disabled", jobs: "2 queued, 1 running" });
    assert.deepEqual(view.activity.map((entry) => [entry.text, entry.when, entry.href]), [["inbox.message.received", "2 min ago", "/status"]]);
  });

  it("tells no module enabled apart from modules enabled whose cards this viewer may not see", () => {
    const none = buildDashboard({ cards: cards(), overview: null, now: NOW });
    assert.deepEqual([none.empty, none.hidden], [true, false]);
    const hidden = buildDashboard({ cards: cards({ enabled: 4 }), overview: null, now: NOW });
    assert.deepEqual([hidden.empty, hidden.hidden], [false, true], "four modules are enabled, none lets this viewer see a card");
    const shown = buildDashboard({ cards: cards({ enabled: 1, stats: [statCard()] }), overview: null, now: NOW });
    assert.deepEqual([shown.empty, shown.hidden], [false, false]);
    const admin = buildDashboard({ cards: cards({ enabled: 4 }), overview: overview(), now: NOW });
    assert.deepEqual([admin.empty, admin.hidden], [false, false], "an administrator always has the platform block");
  });
});
