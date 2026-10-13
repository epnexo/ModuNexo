import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import { MAX_TRUSTED_PROXIES, readTrustedProxies, readTrustedProxyList, setTrustedProxies, validateTrustedProxies } from "../src/auth/trusted-proxies.ts";
import { migrate } from "../src/runner.ts";
import { Registry } from "../src/registry.ts";
import { openTestPool } from "../src/testing.ts";
import { formatIp, parseIp } from "../src/auth/ip.ts";
import { cidrContains } from "../src/auth/ip.ts";

describe("validateTrustedProxies", () => {
  it("accepts addresses and ranges as a list or as comma and line separated text", () => {
    assert.deepEqual(validateTrustedProxies(["10.0.0.2", "192.168.1.0/24"]), { ok: true, value: ["10.0.0.2", "192.168.1.0/24"] });
    assert.deepEqual(validateTrustedProxies("10.0.0.2, 192.168.1.0/24\nfd00::/8"), { ok: true, value: ["10.0.0.2", "192.168.1.0/24", "fd00::/8"] });
  });

  it("trims, drops blanks and duplicates, and accepts an empty list", () => {
    assert.deepEqual(validateTrustedProxies("  10.0.0.2 ,, 10.0.0.2\n\n"), { ok: true, value: ["10.0.0.2"] });
    assert.deepEqual(validateTrustedProxies(""), { ok: true, value: [] });
    assert.deepEqual(validateTrustedProxies([]), { ok: true, value: [] });
  });

  it("refuses an entry that is not an address or a range, naming it", () => {
    for (const input of ["example.com", "10.0.0.0/33", "10.0.0.2, nope", ["10.0.0.2", "300.1.1.1"]]) {
      const result = validateTrustedProxies(input);
      assert.equal(result.ok, false, JSON.stringify(input));
      if (!result.ok) assert.match(result.message, /security\.trustedProxies/);
    }
    const named = validateTrustedProxies("10.0.0.2, nope");
    assert.ok(!named.ok && /"nope"/.test(named.message));
  });

  it("refuses anything that is not text or a list of text", () => {
    for (const input of [5, null, undefined, {}, [1], [["10.0.0.2"]]]) assert.equal(validateTrustedProxies(input).ok, false, JSON.stringify(input));
  });

  it("refuses a range far too broad to be a list of proxies, with the smallest allowed prefix in the message", () => {
    for (const input of ["0.0.0.0/1", "128.0.0.0/2", "8.0.0.0/7", "::/1", "2000::/3", "fe00::/7"]) {
      const result = validateTrustedProxies(input);
      assert.equal(result.ok, false, input);
      if (!result.ok) assert.match(result.message, /too broad/);
    }
    assert.equal(validateTrustedProxies("8.0.0.0/8").ok, true);
    assert.equal(validateTrustedProxies("fd00::/16").ok, true);
  });

  it("refuses a list longer than the limit", () => {
    const many = Array.from({ length: MAX_TRUSTED_PROXIES + 1 }, (_, i) => `10.0.${Math.floor(i / 200)}.${(i % 200) + 1}`);
    const result = validateTrustedProxies(many);
    assert.equal(result.ok, false);
    assert.equal(validateTrustedProxies(many.slice(0, MAX_TRUSTED_PROXIES)).ok, true);
  });

  it("refuses 0.0.0.0/0 and ::/0, which would trust the whole internet and defeat the point", () => {
    for (const input of ["0.0.0.0/0", "::/0", "10.0.0.2, 0.0.0.0/0"]) {
      const result = validateTrustedProxies(input);
      assert.equal(result.ok, false, input);
      if (!result.ok) assert.match(result.message, /every address/);
    }
    assert.equal(validateTrustedProxies("10.0.0.0/8").ok, true, "a private block is a choice the owner can make");
    assert.equal(validateTrustedProxies("fd00::/8").ok, true);
  });
});

let pool: pg.Pool | undefined;
let skipReason: string | undefined;

before(async () => {
  ({ pool, skipReason } = await openTestPool());
  if (pool) {
    const registry = new Registry();
    registry.registerCore();
    await migrate(pool, registry);
  }
});

after(async () => {
  if (pool) {
    await pool.query("delete from core.platform_settings where key = 'security.trustedProxies'");
    await pool.query("delete from core.settings_events where key = 'security.trustedProxies'");
    await pool.end();
  }
});

const test = (name: string, run: () => Promise<void>) =>
  it(name, async (t) => {
    if (!pool) return t.skip(skipReason);
    await pool.query("delete from core.platform_settings where key = 'security.trustedProxies'");
    await pool.query("delete from core.settings_events where key = 'security.trustedProxies'");
    await run();
  });

describe("trusted proxies in the database", () => {
  test("nobody is trusted until the owner says so", async () => {
    assert.deepEqual(await readTrustedProxies(pool!), []);
  });

  test("stores the list, reads it back as ranges, and audits who set it without the value", async () => {
    const stored = await setTrustedProxies(pool!, "10.0.0.2, 192.168.1.0/24", "ada@example.test");
    assert.deepEqual(stored, ["10.0.0.2", "192.168.1.0/24"]);
    const ranges = await readTrustedProxies(pool!);
    assert.equal(ranges.length, 2);
    assert.equal(cidrContains(ranges[1]!, parseIp("192.168.1.77")!), true);
    assert.equal(formatIp(parseIp("10.0.0.2")!), "10.0.0.2");
    const events = (await pool!.query("select scope, key, action, actor from core.settings_events where key = 'security.trustedProxies'")).rows;
    assert.deepEqual(events, [{ scope: "platform", key: "security.trustedProxies", action: "set", actor: "ada@example.test" }]);
  });

  test("an empty list removes the setting and logs an unset, and clearing nothing logs nothing", async () => {
    await setTrustedProxies(pool!, "10.0.0.2", "tester");
    assert.deepEqual(await setTrustedProxies(pool!, "", "tester"), []);
    assert.equal((await pool!.query("select 1 from core.platform_settings where key = 'security.trustedProxies'")).rowCount, 0);
    await setTrustedProxies(pool!, [], "tester");
    const actions = (await pool!.query("select action from core.settings_events where key = 'security.trustedProxies' order by id")).rows.map((r) => r.action);
    assert.deepEqual(actions, ["set", "unset"]);
  });

  test("refuses an invalid list, changes nothing and logs nothing", async () => {
    await setTrustedProxies(pool!, "10.0.0.2", "tester");
    await assert.rejects(setTrustedProxies(pool!, "10.0.0.2, nope", "tester"), /security\.trustedProxies/);
    assert.deepEqual((await readTrustedProxies(pool!)).length, 1);
    assert.equal((await pool!.query("select 1 from core.settings_events where key = 'security.trustedProxies'")).rowCount, 1);
  });

  test("reads the list as the owner wrote it, for the screen, and an empty one when nothing valid is stored", async () => {
    assert.deepEqual(await readTrustedProxyList(pool!), []);
    await setTrustedProxies(pool!, ["10.0.0.2", "192.168.1.0/24"], "tester");
    assert.deepEqual(await readTrustedProxyList(pool!), ["10.0.0.2", "192.168.1.0/24"]);
    await pool!.query("update core.platform_settings set value = '[\"10.0.0.2\", \"nope\"]'::jsonb where key = 'security.trustedProxies'");
    assert.deepEqual(await readTrustedProxyList(pool!), []);
  });

  test("the list shown on the screen is the same one that is trusted: a stored string is neither", async () => {
    await pool!.query("insert into core.platform_settings (key, value, updated_by) values ('security.trustedProxies', '\"10.0.0.2\"'::jsonb, 'test')");
    assert.deepEqual(await readTrustedProxies(pool!), []);
    assert.deepEqual(await readTrustedProxyList(pool!), []);
  });

  test("a stored value that is no longer valid trusts nobody instead of failing", async () => {
    for (const value of ['"10.0.0.2"', '["10.0.0.2", "nope"]', "5", "null", '{"a":1}', '["0.0.0.0/0"]']) {
      await pool!.query("delete from core.platform_settings where key = 'security.trustedProxies'");
      await pool!.query("insert into core.platform_settings (key, value, updated_by) values ('security.trustedProxies', $1::jsonb, 'test')", [value]);
      assert.deepEqual(await readTrustedProxies(pool!), [], value);
    }
  });
});
