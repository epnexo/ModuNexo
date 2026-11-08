import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import type pg from "pg";
import { ApiAddressService } from "../src/api-access/index.ts";
import { migrate } from "../src/runner.ts";
import { SettingValueError } from "../src/settings/service.ts";
import { openTestPool } from "../src/testing.ts";
import { Sandbox } from "./sandbox.ts";

let pool: pg.Pool | undefined;
let skipReason: string | undefined;
let box: Sandbox;
let service: ApiAddressService;

before(async () => {
  ({ pool, skipReason } = await openTestPool());
  if (!pool) return;
  box = new Sandbox(pool);
  await migrate(pool, box.registry());
  service = new ApiAddressService(pool);
});
after(async () => {
  if (pool) {
    await pool.query("delete from core.platform_settings where key = 'api.address'");
    await pool.query("delete from core.settings_events where key = 'api.address'");
    await box.cleanup();
    await pool.end();
  }
});
const test = (name: string, run: () => Promise<void>) =>
  it(name, async (t) => {
    if (!pool) return t.skip(skipReason);
    await pool.query("delete from core.platform_settings where key = 'api.address'");
    await pool.query("delete from core.settings_events where key = 'api.address'");
    await run();
  });
const events = async () => (await pool!.query("select scope, action, actor from core.settings_events where key = 'api.address' order by id")).rows;

describe("ApiAddressService", () => {
  test("stores the normalized address and logs who set it, never the value", async () => {
    assert.equal(await service.get(), null);
    await service.set(" https://modunexo.home.arpa/settings ", "admin@example.com");
    assert.equal(await service.get(), "https://modunexo.home.arpa");
    assert.deepEqual(await events(), [{ scope: "platform", action: "set", actor: "admin@example.com" }]);
  });

  test("refuses a bad address and changes nothing", async () => {
    await service.set("https://a.test", "admin");
    await assert.rejects(() => service.set("ftp://b.test", "admin"), SettingValueError);
    assert.equal(await service.get(), "https://a.test");
    assert.equal((await events()).length, 1);
  });

  test("unset removes it, and unsetting nothing logs nothing", async () => {
    await service.unset("admin");
    assert.deepEqual(await events(), []);
    await service.set("https://a.test", "admin");
    await service.unset("admin");
    assert.equal(await service.get(), null);
    assert.deepEqual((await events()).map((e) => e.action), ["set", "unset"]);
  });
});
