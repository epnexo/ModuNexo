import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import { AppearanceService, CUSTOM_CSS_KEY, readCustomCss, readServedCustomCss, readServedUserCss } from "../src/settings/appearance-service.ts";
import { SettingValueError } from "../src/settings/service.ts";
import { migrate } from "../src/runner.ts";
import { openTestPool } from "../src/testing.ts";
import { Sandbox } from "./sandbox.ts";

let pool: pg.Pool | undefined;
let skipReason: string | undefined;
let box: Sandbox;
let service: AppearanceService;

before(async () => {
  ({ pool, skipReason } = await openTestPool());
  if (!pool) return;
  box = new Sandbox(pool);
  box.add();
  await migrate(pool, box.registry());
  service = new AppearanceService(pool, box.registry());
});

const wipe = async () => {
  await pool!.query("delete from core.platform_settings where key = $1", [CUSTOM_CSS_KEY]);
  await pool!.query("delete from core.settings_events where key = $1", [CUSTOM_CSS_KEY]);
};

after(async () => {
  if (pool) {
    await wipe();
    await box.cleanup();
    await pool.end();
  }
});

const test = (name: string, run: () => Promise<void>) =>
  it(name, async (t) => {
    if (!pool) return t.skip(skipReason);
    await wipe();
    await run();
  });

const events = async () => (await pool!.query("select scope, key, action, actor from core.settings_events where key = $1 order by id", [CUSTOM_CSS_KEY])).rows;

describe("the company's custom CSS", () => {
  test("is nothing on a fresh instance", async () => {
    assert.equal(await readCustomCss(pool!), "");
    assert.equal(await readServedCustomCss(pool!), "");
    assert.equal(await service.customCss(), "");
  });

  test("keeps what the administrator wrote, serves it sanitised, and logs who changed it without logging the text", async () => {
    const text = "/* mine */\n.card { border-color: var(--accent); padding: 1rem }\n";
    await service.setCustomCss(text, "admin@example.test");
    assert.equal(await service.customCss(), text);
    assert.equal(await readServedCustomCss(pool!), "@layer custom{.card{border-color:var(--accent);padding:1rem;}}");
    assert.deepEqual(await events(), [{ scope: "platform", key: CUSTOM_CSS_KEY, action: "set", actor: "admin@example.test" }]);
  });

  test("refuses a stylesheet with anything not allowed, says every line, and changes nothing", async () => {
    await service.setCustomCss(".card{padding:1rem}", "a");
    await assert.rejects(
      service.setCustomCss(".card{padding:2rem}\nbody{color:red}\n.card{background:url(https://evil.example/x)}", "a"),
      (error) => error instanceof SettingValueError && /line 2: selector "body" is not allowed/.test(error.message) && /line 3: property "background" is not allowed/.test(error.message),
    );
    assert.equal(await service.customCss(), ".card{padding:1rem}");
    assert.equal((await events()).length, 1, "the refusal left no audit row");
  });

  test("clears the stylesheet when the text is blank, and logs it once", async () => {
    await service.setCustomCss(".card{padding:1rem}", "a");
    await service.setCustomCss("  \n", "b");
    assert.equal(await service.customCss(), "");
    assert.deepEqual((await events()).map((e) => [e.action, e.actor]), [["set", "a"], ["unset", "b"]]);
    await service.clearCustomCss("c");
    assert.equal((await events()).length, 2, "clearing nothing logs nothing");
  });

  test("never serves what the database holds if it no longer passes, even when someone wrote it there directly", async () => {
    await pool!.query("insert into core.platform_settings (key, value, updated_by) values ($1, $2::jsonb, 'direct')", [CUSTOM_CSS_KEY, JSON.stringify('@import "https://evil.example/x.css"; .card{padding:1rem}')]);
    assert.equal(await readServedCustomCss(pool!), "");
    await pool!.query("update core.platform_settings set value = $2::jsonb where key = $1", [CUSTOM_CSS_KEY, JSON.stringify(12345)]);
    assert.equal(await readServedCustomCss(pool!), "", "a value that is not text is ignored");
  });
});

describe("a person's own custom CSS", () => {
  const insertUser = async (id: string) => {
    await pool!.query(`insert into core.auth_user ("id", "name", "email", "emailVerified") values ($1, $1, $1 || '@example.test', true) on conflict do nothing`, [id]);
  };
  const wipeUsers = async () => {
    await pool!.query("delete from core.auth_user where \"id\" in ('t6d-ada', 't6d-bob')");
    await pool!.query("delete from core.settings_events where key = 'custom-css.person'");
  };
  const personTest = (name: string, run: () => Promise<void>) =>
    it(name, async (t) => {
      if (!pool) return t.skip(skipReason);
      await wipeUsers();
      await insertUser("t6d-ada");
      await insertUser("t6d-bob");
      try {
        await run();
      } finally {
        await wipeUsers();
      }
    });

  personTest("is nothing until the person writes it, and is theirs alone", async () => {
    assert.equal(await service.userCss("t6d-ada"), "");
    await service.setUserCss("t6d-ada", ".card{border-color:var(--accent)}", "ada@example.test");
    assert.equal(await service.userCss("t6d-ada"), ".card{border-color:var(--accent)}");
    assert.equal(await service.userCss("t6d-bob"), "", "another person has none");
    assert.equal(await readServedUserCss(pool!, "t6d-ada"), "@layer person{.card{border-color:var(--accent);}}");
    assert.equal(await readServedUserCss(pool!, "t6d-bob"), "");
    assert.equal(await readServedUserCss(pool!, null), "", "the local operator has no person");
  });

  personTest("checks it as a whole with the same rules as the company's, logs who changed it without the text, and clears on blank", async () => {
    await assert.rejects(service.setUserCss("t6d-ada", ".card{padding:1rem}\nbody{color:red}", "ada@example.test"), (error) => error instanceof SettingValueError && /line 2: selector "body" is not allowed/.test(error.message));
    assert.equal(await service.userCss("t6d-ada"), "");
    await service.setUserCss("t6d-ada", ".card{padding:1rem}", "ada@example.test");
    await service.setUserCss("t6d-ada", "  ", "ada@example.test");
    assert.equal(await service.userCss("t6d-ada"), "");
    const log = (await pool!.query("select scope, key, action, actor from core.settings_events where key = 'custom-css.person' order by id")).rows;
    assert.deepEqual(log, [
      { scope: "user:t6d-ada", key: "custom-css.person", action: "set", actor: "ada@example.test" },
      { scope: "user:t6d-ada", key: "custom-css.person", action: "unset", actor: "ada@example.test" },
    ]);
  });

  personTest("goes away with the person, and never serves what was put in the table by hand", async () => {
    await service.setUserCss("t6d-bob", ".card{padding:1rem}", "bob@example.test");
    await pool!.query('delete from core.auth_user where "id" = $1', ["t6d-bob"]);
    assert.equal((await pool!.query("select 1 from core.user_custom_css where user_id = 't6d-bob'")).rowCount, 0, "deleted with the user");
    await pool!.query("insert into core.user_custom_css (user_id, css) values ('t6d-ada', $1)", ["@import 'https://evil.example/x.css'; .card{padding:1rem}"]);
    assert.equal(await readServedUserCss(pool!, "t6d-ada"), "");
    await assert.rejects(pool!.query("update core.user_custom_css set css = $1 where user_id = 't6d-ada'", ["x".repeat(16 * 1024 + 1)]), /check|violates/i, "the table holds no more than the cap");
  });
});
