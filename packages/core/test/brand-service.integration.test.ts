import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import { BrandService, readBrand, readLogo } from "../src/settings/brand-service.ts";
import { SettingValueError } from "../src/settings/service.ts";
import { migrate } from "../src/runner.ts";
import { Registry } from "../src/registry.ts";
import { openTestPool } from "../src/testing.ts";

let pool: pg.Pool | undefined;
let skipReason: string | undefined;
let service: BrandService;
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("logo")]);
const business = { kind: "business", name: "Acme SAS", representative: "Ana Ruiz", email: "ana@acme.co" };

const clean = async () => {
  await pool!.query("delete from core.platform_settings where key = 'brand.profile'");
  await pool!.query("delete from core.brand_assets");
  await pool!.query("delete from core.settings_events where key like 'brand.%'");
};
before(async () => {
  ({ pool, skipReason } = await openTestPool());
  if (!pool) return;
  const registry = new Registry();
  registry.registerCore();
  await migrate(pool, registry);
  service = new BrandService(pool);
});
after(async () => {
  if (pool) {
    await clean();
    await pool.end();
  }
});
const test = (name: string, run: () => Promise<void>) =>
  it(name, async (t) => {
    if (!pool) return t.skip(skipReason);
    await clean();
    await run();
  });

describe("BrandService", () => {
  test("nothing stored reads as no profile and no logo", async () => {
    assert.deepEqual(await readBrand(pool!), { profile: null, logo: null });
    assert.equal(await readLogo(pool!), null);
  });
  test("a profile is stored, read back and recorded", async () => {
    await service.setProfile(business, "admin@x");
    assert.deepEqual((await readBrand(pool!)).profile, business);
    const events = await pool!.query("select action, actor from core.settings_events where key = 'brand.profile'");
    assert.deepEqual(events.rows, [{ action: "set", actor: "admin@x" }]);
  });
  test("an invalid profile is refused and stores nothing", async () => {
    await assert.rejects(service.setProfile({ ...business, email: "nope" }, "a"), SettingValueError);
    assert.equal((await readBrand(pool!)).profile, null);
  });
  test("a logo is stored by its bytes, replaced in place and cleared", async () => {
    const first = await service.setLogo(png, "a");
    const stored = await readLogo(pool!);
    assert.equal(stored?.contentType, "image/png");
    assert.deepEqual(stored?.bytes, png);
    assert.equal((await readBrand(pool!)).logo, first);
    const second = await service.setLogo(Buffer.concat([png, Buffer.from("2")]), "a");
    assert.notEqual(second, first);
    assert.equal((await pool!.query("select count(*)::int as n from core.brand_assets")).rows[0].n, 1);
    await service.clearLogo("a");
    assert.equal(await readLogo(pool!), null);
  });
  test("a file that is not an image is refused whatever its name", async () => {
    await assert.rejects(service.setLogo(Buffer.from("<svg><script/></svg>"), "a"), SettingValueError);
    assert.equal(await readLogo(pool!), null);
  });
  test("clearing what is not there logs nothing; clearing the profile restores the default", async () => {
    await service.clearLogo("a");
    await service.clearProfile("a");
    assert.equal((await pool!.query("select count(*)::int as n from core.settings_events where key like 'brand.%'")).rows[0].n, 0);
    await service.setProfile(business, "a");
    await service.clearProfile("a");
    assert.equal((await readBrand(pool!)).profile, null);
  });
  test("a stored profile that no longer validates reads as none", async () => {
    await pool!.query("insert into core.platform_settings (key, value, updated_by) values ('brand.profile', '{\"kind\":\"business\"}'::jsonb, 'x')");
    assert.equal((await readBrand(pool!)).profile, null);
  });
});
