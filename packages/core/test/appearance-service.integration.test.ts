import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import { AppearanceService, readAppearance } from "../src/settings/appearance-service.ts";
import { DEFAULT_APPEARANCE } from "../src/settings/appearance.ts";
import { SettingValueError, SettingsError } from "../src/settings/service.ts";
import { purgeModule } from "../src/purge.ts";
import { migrate } from "../src/runner.ts";
import { openTestPool } from "../src/testing.ts";
import { Sandbox } from "./sandbox.ts";

let pool: pg.Pool | undefined;
let skipReason: string | undefined;
let box: Sandbox;
let moduleId: string;
let service: AppearanceService;

before(async () => {
  ({ pool, skipReason } = await openTestPool());
  if (!pool) return;
  box = new Sandbox(pool);
  moduleId = box.add().manifest.id;
  await migrate(pool, box.registry());
  service = new AppearanceService(pool, box.registry());
});

after(async () => {
  if (pool) {
    await pool.query("delete from core.platform_settings where key like 'appearance.%'");
    await pool.query("delete from core.settings_events where scope in ('platform', $1)", [moduleId]);
    await box.cleanup();
    await pool.end();
  }
});

const test = (name: string, run: () => Promise<void>) =>
  it(name, async (t) => {
    if (!pool) return t.skip(skipReason);
    await pool.query("delete from core.platform_settings where key like 'appearance.%'");
    await pool.query("delete from core.settings_events where scope in ('platform', $1)", [moduleId]);
    await run();
  });

const events = async () => (await pool!.query("select scope, key, action, actor from core.settings_events where scope in ('platform', $1) order by id", [moduleId])).rows;

describe("AppearanceService", () => {
  test("is the defaults on a fresh instance", async () => {
    assert.deepEqual(await service.get(), { platform: DEFAULT_APPEARANCE, modules: {} });
  });

  test("stores the platform appearance, validated, with who changed it", async () => {
    await service.setPlatform({ theme: "dark", accentHue: 140 }, "ada@example.test");
    assert.deepEqual((await service.get()).platform, { theme: "dark", accentHue: 140, radius: "default" });
    assert.deepEqual(await events(), [
      { scope: "platform", key: "appearance.theme", action: "set", actor: "ada@example.test" },
      { scope: "platform", key: "appearance.accentHue", action: "set", actor: "ada@example.test" },
    ]);
  });

  test("refuses an invalid value naming the setting, and changes and logs nothing", async () => {
    await service.setPlatform({ accentHue: 100 }, "tester");
    await assert.rejects(service.setPlatform({ theme: "dark", accentHue: 999 }, "tester"), (e: unknown) => e instanceof SettingValueError && /accentHue/.test(e.message));
    assert.deepEqual((await service.get()).platform, { ...DEFAULT_APPEARANCE, accentHue: 100 }, "nothing from the refused batch was applied");
    assert.equal((await events()).length, 1);
  });

  test("readAppearance reads the same state without a registry", async () => {
    await service.setPlatform({ accentHue: 77 }, "tester");
    await service.setModule(moduleId, { radius: "round" }, "tester");
    assert.deepEqual(await readAppearance(pool!), await service.get());
  });

  test("stores a module's override and clears it, and only a known module can have one", async () => {
    await service.setModule(moduleId, { accentHue: 20, radius: "sharp" }, "tester");
    assert.deepEqual((await service.get()).modules, { [moduleId]: { accentHue: 20, radius: "sharp" } });
    await service.clearModule(moduleId, "tester");
    assert.deepEqual((await service.get()).modules, {});
    await assert.rejects(service.setModule("no-such-module", { accentHue: 1 }, "tester"), SettingsError);
  });

  test("clearing a module with no override does nothing and logs nothing", async () => {
    await service.clearModule(moduleId, "tester");
    assert.deepEqual(await events(), []);
  });

  test("purging a module removes its appearance override and no one else's", async () => {
    const other = box.add();
    const registry = box.registry();
    await migrate(pool!, registry);
    const scoped = new AppearanceService(pool!, registry);
    await scoped.setModule(moduleId, { accentHue: 30 }, "tester");
    await scoped.setModule(other.manifest.id, { accentHue: 40 }, "tester");
    await purgeModule(pool!, registry, moduleId);
    assert.deepEqual((await scoped.get()).modules, { [other.manifest.id]: { accentHue: 40 } });
  });
});
