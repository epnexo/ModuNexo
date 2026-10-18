import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import type { SettingDeclaration } from "@modunexo/sdk";
import { SecretUnreadableError } from "../src/settings/crypto.ts";
import { SettingValueError, SettingsError, SettingsService } from "../src/settings/service.ts";
import { migrate } from "../src/runner.ts";
import { openTestPool } from "../src/testing.ts";
import { Sandbox } from "./sandbox.ts";

const KEY = "m".repeat(40);
const OTHER_KEY = "n".repeat(40);
const DECLARATIONS: SettingDeclaration[] = [
  { key: "site.title", label: "Site title", type: "string", default: "Untitled" },
  { key: "page.size", label: "Page size", type: "number", default: 25 },
  { key: "feature.on", label: "Feature enabled", type: "boolean", default: false },
  { key: "report.format", label: "Report format", type: "select", options: ["pdf", "csv"], default: "pdf" },
  { key: "export.dir", label: "Export directory", type: "path", required: true },
  { key: "api.token", label: "API token", type: "secret", required: true },
  { key: "note", label: "Note", type: "string" },
];

let pool: pg.Pool | undefined;
let skipReason: string | undefined;
let box: Sandbox;
let moduleId: string;
let service: SettingsService;

before(async () => {
  ({ pool, skipReason } = await openTestPool());
  if (!pool) return;
  box = new Sandbox(pool);
  const mod = box.add();
  mod.manifest.settings = DECLARATIONS;
  moduleId = mod.manifest.id;
  await migrate(pool, box.registry());
  service = new SettingsService(pool, box.registry(), { masterKey: KEY });
});

after(async () => {
  if (pool) {
    // Only this file's own module: another file shares this database and its rows must not be swept away.
    await pool.query("delete from core.module_settings where module_id = $1", [moduleId]);
    await pool.query("delete from core.settings_events where scope = $1", [moduleId]);
    await box.cleanup();
    await pool.end();
  }
});

const test = (name: string, run: () => Promise<void>) =>
  it(name, async (t) => {
    if (!pool) return t.skip(skipReason);
    await pool.query("delete from core.module_settings where module_id = $1", [moduleId]);
    await pool.query("delete from core.settings_events where scope = $1", [moduleId]);
    await run();
  });

const entry = async (key: string) => (await service.describe(moduleId)).find((e) => e.key === key)!;
const events = async () => (await pool!.query("select key, action, actor from core.settings_events where scope = $1 order by id", [moduleId])).rows;

describe("SettingsService: reading", () => {
  test("describes every declared setting with its default and where the effective value comes from", async () => {
    const all = await service.describe(moduleId);
    assert.deepEqual(all.map((e) => e.key), DECLARATIONS.map((d) => d.key));
    assert.deepEqual(
      { source: (await entry("site.title")).source, effective: (await entry("site.title")).effective },
      { source: "default", effective: "Untitled" },
    );
    assert.deepEqual({ source: (await entry("note")).source, effective: (await entry("note")).effective }, { source: "unset", effective: null });
  });

  test("get returns the stored value, else the default, else null", async () => {
    assert.equal(await service.get(moduleId, "page.size"), 25);
    assert.equal(await service.get(moduleId, "note"), null);
    await service.set(moduleId, "page.size", "50", "tester");
    assert.equal(await service.get(moduleId, "page.size"), 50);
  });

  test("refuses an unknown module and an undeclared key", async () => {
    await assert.rejects(service.describe("no-such-module"), SettingsError);
    await assert.rejects(service.get(moduleId, "not.declared"), (e: unknown) => e instanceof SettingsError && /not\.declared/.test(e.message));
    await assert.rejects(service.set(moduleId, "not.declared", "x", "tester"), SettingsError);
  });
});

describe("SettingsService: writing", () => {
  test("stores each type as its own type and records who did it, without the value", async () => {
    await service.set(moduleId, "site.title", "My site", "ada@example.test");
    await service.set(moduleId, "page.size", "40", "ada@example.test");
    await service.set(moduleId, "feature.on", "true", "ada@example.test");
    await service.set(moduleId, "report.format", "csv", "ada@example.test");
    await service.set(moduleId, "export.dir", " /srv/exports ", "ada@example.test");
    assert.equal(await service.get(moduleId, "site.title"), "My site");
    assert.equal(await service.get(moduleId, "page.size"), 40);
    assert.equal(await service.get(moduleId, "feature.on"), true);
    assert.equal(await service.get(moduleId, "report.format"), "csv");
    assert.equal(await service.get(moduleId, "export.dir"), "/srv/exports");
    const rows = (await pool!.query("select key, value, updated_by from core.module_settings where module_id = $1 order by key", [moduleId])).rows;
    assert.deepEqual(rows.find((r) => r.key === "page.size"), { key: "page.size", value: 40, updated_by: "ada@example.test" });
    assert.equal((await events()).length, 5);
    assert.ok(JSON.stringify(await events()).indexOf("My site") === -1, "the audit trail never holds a value");
  });

  test("refuses an invalid value with a message naming the key, and changes nothing", async () => {
    await service.set(moduleId, "page.size", 30, "tester");
    await assert.rejects(
      service.set(moduleId, "page.size", "lots", "tester"),
      (e: unknown) => e instanceof SettingValueError && /page\.size/.test(e.message),
    );
    await assert.rejects(service.set(moduleId, "report.format", "xls", "tester"), SettingValueError);
    assert.equal(await service.get(moduleId, "page.size"), 30);
    assert.equal((await events()).length, 1, "a refused change leaves no audit row");
  });

  test("unset removes the stored value so the default applies again, and an unset of nothing is silent", async () => {
    await service.set(moduleId, "page.size", 99, "tester");
    await service.unset(moduleId, "page.size", "tester");
    assert.equal(await service.get(moduleId, "page.size"), 25);
    await service.unset(moduleId, "page.size", "tester");
    assert.deepEqual((await events()).map((e) => e.action), ["set", "unset"]);
  });
});

describe("SettingsService: applyMany", () => {
  test("applies sets and unsets together and audits each", async () => {
    await service.set(moduleId, "note", "old note", "tester");
    await service.applyMany(
      moduleId,
      [
        { op: "set", key: "site.title", value: "Batch title" },
        { op: "set", key: "page.size", value: "60" },
        { op: "unset", key: "note" },
        { op: "set", key: "api.token", value: "batch-secret-value-1" },
      ],
      "ada@example.test",
    );
    assert.equal(await service.get(moduleId, "site.title"), "Batch title");
    assert.equal(await service.get(moduleId, "page.size"), 60);
    assert.equal(await service.get(moduleId, "note"), null);
    assert.equal(await service.get(moduleId, "api.token"), "batch-secret-value-1");
    const batch = (await events()).filter((e) => e.actor === "ada@example.test");
    assert.deepEqual(batch.map((e) => `${e.action}:${e.key}`).sort(), ["set:api.token", "set:page.size", "set:site.title", "unset:note"]);
  });

  test("applies none of them when one is refused", async () => {
    await service.set(moduleId, "site.title", "Before", "tester");
    await assert.rejects(
      service.applyMany(moduleId, [{ op: "set", key: "site.title", value: "After" }, { op: "set", key: "page.size", value: "lots" }], "tester"),
      (e: unknown) => e instanceof SettingValueError && /page\.size/.test(e.message),
    );
    await assert.rejects(service.applyMany(moduleId, [{ op: "set", key: "site.title", value: "After" }, { op: "unset", key: "not.declared" }], "tester"), SettingsError);
    assert.equal(await service.get(moduleId, "site.title"), "Before");
    assert.equal((await events()).length, 1, "only the first, separate write was audited");
  });

  test("rolls everything back when the database refuses part of it", async () => {
    await service.set(moduleId, "site.title", "Before", "tester");
    // A trigger-free way to make the second statement fail: the module settings row is locked out by a check.
    await pool!.query(`alter table core.module_settings add constraint e2e_block check (module_id <> '${moduleId}' or key <> 'page.size') not valid`);
    try {
      await assert.rejects(service.applyMany(moduleId, [{ op: "set", key: "site.title", value: "After" }, { op: "set", key: "page.size", value: "40" }], "tester"));
    } finally {
      await pool!.query("alter table core.module_settings drop constraint e2e_block");
    }
    assert.equal(await service.get(moduleId, "site.title"), "Before");
    assert.equal((await events()).length, 1);
  });
});

describe("SettingsService: secrets", () => {
  const PLAIN = "tok_live_9f8e7d6c5b4a";

  test("stores a secret encrypted, shows only that it is set, and hands the value to server code only through get", async () => {
    await service.set(moduleId, "api.token", PLAIN, "ada@example.test");
    const stored = (await pool!.query("select value, secret from core.module_settings where module_id = $1 and key = 'api.token'", [moduleId])).rows[0];
    assert.equal(stored.value, null);
    assert.match(stored.secret, /^v1\./);
    assert.ok(!stored.secret.includes(PLAIN));

    const described = await entry("api.token");
    assert.deepEqual(described.secret, { set: true, unreadable: false });
    assert.equal(described.effective, null);
    assert.ok(!JSON.stringify(await service.describe(moduleId)).includes(PLAIN));
    assert.ok(!JSON.stringify(await events()).includes(PLAIN));
    assert.equal(await service.get(moduleId, "api.token"), PLAIN);
  });

  test("replacing a secret works and unset clears it", async () => {
    await service.set(moduleId, "api.token", "first-secret-value", "tester");
    await service.set(moduleId, "api.token", "second-secret-value", "tester");
    assert.equal(await service.get(moduleId, "api.token"), "second-secret-value");
    await service.unset(moduleId, "api.token", "tester");
    assert.deepEqual((await entry("api.token")).secret, { set: false, unreadable: false });
    assert.equal(await service.get(moduleId, "api.token"), null);
  });

  test("a secret under another master key is flagged unreadable, does not break the listing, and can be replaced", async () => {
    await service.set(moduleId, "api.token", PLAIN, "tester");
    const rotated = new SettingsService(pool!, box.registry(), { masterKey: OTHER_KEY });
    const described = (await rotated.describe(moduleId)).find((e) => e.key === "api.token")!;
    assert.deepEqual(described.secret, { set: true, unreadable: true });
    await assert.rejects(rotated.get(moduleId, "api.token"), SecretUnreadableError);
    await rotated.set(moduleId, "api.token", "fresh-value-123", "tester");
    assert.equal(await rotated.get(moduleId, "api.token"), "fresh-value-123");
  });

  test("a refused secret is not echoed", async () => {
    await assert.rejects(service.set(moduleId, "api.token", "", "tester"), (e: unknown) => e instanceof SettingValueError && /api\.token/.test(e.message));
  });
});

describe("SettingsService: required settings", () => {
  test("lists a required setting that has neither a value nor a default, and stops once it is set", async () => {
    assert.deepEqual((await service.incomplete(moduleId)).sort(), ["api.token", "export.dir"]);
    assert.equal((await entry("export.dir")).incomplete, true);
    await service.set(moduleId, "export.dir", "/srv/x", "tester");
    await service.set(moduleId, "api.token", "a-token-value", "tester");
    assert.deepEqual(await service.incomplete(moduleId), []);
  });

  test("a stored value the declaration no longer accepts falls back to the default and is flagged", async () => {
    await pool!.query("insert into core.module_settings (module_id, key, value, updated_by) values ($1, 'report.format', '\"xls\"'::jsonb, 'test')", [moduleId]);
    const e = await entry("report.format");
    assert.equal(e.effective, "pdf");
    assert.equal(e.source, "default");
    assert.equal(e.invalid, true);
    assert.equal(await service.get(moduleId, "report.format"), "pdf");
  });
});
