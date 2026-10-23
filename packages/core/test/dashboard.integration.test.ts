import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import type pg from "pg";
import { DashboardService } from "../src/dashboard/service.ts";
import { migrate } from "../src/runner.ts";
import { createPool } from "../src/pool.ts";
import { createScratchDatabase } from "../src/testing.ts";
import { Sandbox } from "./sandbox.ts";

let pool: pg.Pool | undefined;
let skipReason: string | undefined;
let drop: (() => Promise<void>) | undefined;
let box: Sandbox;
let rich: string;
let plain: string;
let off: string;
let service: DashboardService;
let incomplete: Record<string, string[]> = {};

const everyone = () => true;

async function setState(id: string, state: "enabled" | "disabled"): Promise<void> {
  await pool!.query("delete from core.modules where id = $1", [id]);
  await pool!.query("insert into core.modules (id, state, installed_version) values ($1, $2, '1.0.0')", [id, state]);
}

before(async () => {
  const scratch = await createScratchDatabase();
  if (scratch.url === undefined) {
    skipReason = scratch.skipReason;
    return;
  }
  drop = scratch.drop;
  pool = createPool(scratch.url);
  box = new Sandbox(pool);
  const first = box.add();
  const second = box.add();
  const third = box.add();
  for (const mod of [first, second, third]) mod.write("0001_init.sql", "create table items (id serial primary key, label text not null);");
  first.manifest.permissions = [{ key: "items.read", label: "Read items" }];
  first.manifest.dashboard = {
    stats: [
      { key: "items", label: "Items", href: "/items", sql: "select count(*) from items" },
      { key: "latest", label: "Latest", href: "/items", sql: "select label from items order by id desc limit 1" },
      { key: "broken", label: "Broken", href: "/items", sql: "select count(*) from no_such_table" },
      { key: "writes", label: "Writes", href: "/items", sql: "with w as (insert into items (label) values ('sneaky') returning 1) select count(*) from w" },
      { key: "slow", label: "Slow", href: "/items", sql: "select pg_sleep(2)" },
      { key: "long", label: "Long", href: "/items", sql: `select repeat('x', 200)` },
      { key: "none", label: "None", href: "/items", sql: "select label from items where false" },
      { key: "private", label: "Private", href: "/items", permission: "items.read", sql: "select count(*) from items" },
    ],
    alerts: [
      { key: "many", label: "Too many items", href: "/items", severity: "warning", sql: "select count(*) from items" },
      { key: "calm", label: "Nothing to see", href: "/items", severity: "error", sql: "select count(*) from items where false" },
      { key: "negative", label: "Negative", href: "/items", severity: "info", sql: "select -1" },
      { key: "text", label: "Text", href: "/items", severity: "info", sql: "select 'many'" },
      { key: "gone", label: "Gone", href: "/items", severity: "error", sql: "select count(*) from no_such_table" },
    ],
  };
  rich = first.manifest.id;
  plain = second.manifest.id;
  off = third.manifest.id;
  third.manifest.dashboard = { stats: [{ key: "items", label: "Hidden", href: "/items", sql: "select count(*) from items" }] };
  await migrate(pool, box.registry());
  service = new DashboardService(pool, box.registry(), { statementTimeoutMs: 400, incompleteSettings: async (id) => incomplete[id] ?? [] });
});

after(async () => {
  if (pool) {
    await box.cleanup();
    await pool.query("delete from core.jobs where module_id = any($1)", [[rich, plain, off]]);
    await pool.query("delete from core.module_operations where module_id = any($1)", [[rich, plain, off]]);
    await pool.end();
  }
  await drop?.();
});

beforeEach(async () => {
  if (!pool) return;
  incomplete = {};
  await pool.query("delete from core.jobs where module_id = any($1)", [[rich, plain, off]]);
  await pool.query("delete from core.module_operations where module_id = any($1)", [[rich, plain, off]]);
  await setState(rich, "enabled");
  await setState(plain, "enabled");
  await setState(off, "disabled");
  await pool.query(`delete from "${box.modules[0]!.manifest.schema}".items`);
  await pool.query(`insert into "${box.modules[0]!.manifest.schema}".items (label) values ('first'), ('second')`);
});

const guard = (name: string, run: () => Promise<void>) =>
  it(name, async (t) => {
    if (!pool) return t.skip(skipReason);
    await run();
  });

describe("DashboardService.cards: what modules contribute", () => {
  guard("shows a count as a number and a text as it is, and an empty result as not available", async () => {
    const { stats } = await service.cards(everyone);
    const by = (key: string) => stats.find((card) => card.moduleId === rich && card.key === key);
    assert.equal(by("items")?.value, 2, "a bigint count arrives as a number");
    assert.equal(by("latest")?.value, "second");
    assert.equal(by("none")?.value, null, "no row means nothing to show");
    assert.deepEqual([by("items")?.label, by("items")?.href, by("items")?.moduleId], ["Items", "/items", rich]);
  });

  guard("shows a card as not available, and never the database's message, when its statement fails, writes, takes too long or answers with too much text", async () => {
    const { stats } = await service.cards(everyone);
    for (const key of ["broken", "writes", "slow", "long"]) {
      assert.equal(stats.find((card) => card.moduleId === rich && card.key === key)?.value, null, key);
    }
    assert.doesNotMatch(JSON.stringify(stats), /no_such_table|relation|read-only|statement timeout|sneaky/i);
    assert.equal((await pool!.query(`select count(*)::int as n from "${box.modules[0]!.manifest.schema}".items where label = 'sneaky'`)).rows[0].n, 0, "the READ ONLY transaction refused the write");
  });

  guard("does not wait for the slow statement longer than the limit, and one failing card does not hide the others", async () => {
    const started = Date.now();
    const { stats } = await service.cards(everyone);
    assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms`);
    assert.equal(stats.find((card) => card.key === "items")?.value, 2);
  });

  guard("lists an alert only while its count is above zero, as a number with its severity", async () => {
    const { alerts } = await service.cards(everyone);
    const mine = alerts.filter((alert) => alert.moduleId === rich);
    const many = mine.find((alert) => alert.key === "many");
    assert.deepEqual([many?.count, many?.severity, many?.label], [2, "warning", "Too many items"]);
    assert.equal(mine.some((alert) => alert.key === "calm"), false, "a count of 0 is not shown");
  });

  guard("reports an alert that cannot be counted as not available, for a failing statement, a negative number and a text", async () => {
    const { alerts } = await service.cards(everyone);
    for (const key of ["gone", "negative", "text"]) {
      assert.equal(alerts.find((alert) => alert.moduleId === rich && alert.key === key)?.count, null, key);
    }
  });

  guard("hides a card from whoever lacks its permission, and asks about that permission", async () => {
    const asked: [string, string | undefined][] = [];
    const { stats } = await service.cards((moduleId, permission) => {
      asked.push([moduleId, permission]);
      return permission === undefined;
    });
    assert.equal(stats.some((card) => card.key === "private"), false);
    assert.ok(asked.some(([id, permission]) => id === rich && permission === "items.read"));
    assert.equal((await service.cards(everyone)).stats.some((card) => card.key === "private"), true);
  });

  guard("leaves out a disabled module and lists an enabled one that declares nothing as silent", async () => {
    const cards = await service.cards(everyone);
    assert.equal(cards.stats.some((card) => card.moduleId === off), false);
    assert.deepEqual(
      cards.silent.map((entry) => entry.moduleId).filter((id) => id === plain || id === rich || id === off),
      [plain],
    );
  });
});

describe("DashboardService.overview: the platform's own signals", () => {
  guard("counts enabled and disabled modules and the jobs waiting and running", async () => {
    await pool!.query(
      "insert into core.jobs (module_id, name, status, max_attempts, timeout_seconds, enqueued_by) values ($1, 'a', 'queued', 3, 60, 't'), ($1, 'b', 'queued', 3, 60, 't')",
      [rich],
    );
    const overview = await service.overview();
    assert.ok(overview.modules.enabled >= 2 && overview.modules.disabled >= 1);
    assert.equal(overview.jobs.queued, 2);
    assert.equal(overview.jobs.running, 0);
  });

  guard("raises an alert for a job that is dead, with its module and name but never its error text, and ignores an old one", async () => {
    await pool!.query(
      `insert into core.jobs (module_id, name, status, attempts, max_attempts, timeout_seconds, enqueued_by, last_error, finished_at)
       values ($1, 'answer', 'dead', 3, 3, 60, 't', 'secret-token-abc failed at http://internal', now()),
              ($1, 'ancient', 'dead', 3, 3, 60, 't', 'old', now() - interval '30 days')`,
      [rich],
    );
    const { alerts } = await service.overview();
    const dead = alerts.filter((alert) => alert.kind === "job_dead" && alert.moduleId === rich);
    assert.equal(dead.length, 1);
    assert.equal(dead[0]!.severity, "error");
    assert.equal(dead[0]!.href, "/status");
    assert.match(dead[0]!.label, /answer/);
    assert.doesNotMatch(JSON.stringify(alerts), /secret-token|internal|ancient/);
  });

  guard("raises an alert for an install or upgrade that failed or was rolled back, and none for one that succeeded", async () => {
    const insert = (status: string, finished: string) =>
      pool!.query(
        `insert into core.module_operations (module_id, version, sha256, kind, status, detail, actor, pid, finished_at)
         values ($1, '2.0.0', repeat('a', 64), 'upgrade', $2, 'private detail', 'op', 1, ${finished})`,
        [rich, status],
      );
    await insert("failed", "now()");
    await insert("succeeded", "now()");
    await insert("rolled_back", "now() - interval '30 days'");
    const { alerts } = await service.overview();
    const failed = alerts.filter((alert) => alert.kind === "operation_failed" && alert.moduleId === rich);
    assert.equal(failed.length, 1);
    assert.equal(failed[0]!.href, "/apps");
    assert.doesNotMatch(JSON.stringify(alerts), /private detail/);
  });

  guard("raises an alert for an enabled module with required settings still unset, with the count and not the keys", async () => {
    incomplete[plain] = ["webhook_secret", "llm.key"];
    incomplete[off] = ["whatever"];
    const { alerts } = await service.overview();
    const open = alerts.filter((alert) => alert.kind === "settings_incomplete");
    assert.deepEqual(open.filter((alert) => alert.moduleId === plain).map((alert) => [alert.count, alert.href]), [[2, "/settings"]]);
    assert.equal(open.some((alert) => alert.moduleId === off), false, "a disabled module is not asked about");
    assert.doesNotMatch(JSON.stringify(alerts), /webhook_secret|llm\.key/);
  });

  guard("lists the newest activity first, from events and operations, without payloads", async () => {
    await pool!.query("insert into core.events (module_id, type, payload) values ($1, $2, $3::jsonb)", [rich, `${rich}.thing.happened`, JSON.stringify({ private: "customer-data" })]);
    const { activity } = await service.overview();
    assert.ok(activity.length >= 1 && activity.length <= 15);
    assert.match(activity[0]!.text, /thing\.happened/);
    assert.doesNotMatch(JSON.stringify(activity), /customer-data/);
    const times = activity.map((entry) => entry.at.getTime());
    assert.deepEqual([...times].sort((a, b) => b - a), times, "newest first");
  });
});
