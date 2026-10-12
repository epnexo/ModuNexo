import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type pg from "pg";
import type { ModuleManifest } from "@epnexo/sdk";
import {
  type HookContext,
  type HookLoader,
  LifecycleRefusedError,
  LifecycleService,
  LifecycleStepError,
  type ModuleHooks,
  fileHookLoader,
  readEvents,
  readStates,
} from "../src/index.ts";
import { MIGRATION_LOCK_NAME } from "../src/runner.ts";
import { openTestPool } from "../src/testing.ts";
import { Sandbox, type Throwaway } from "./sandbox.ts";

let pool: pg.Pool | undefined;
let skipReason: string | undefined;

before(async () => {
  ({ pool, skipReason } = await openTestPool());
});
after(async () => {
  await pool?.end();
});

const HOOK_NAMES = ["onInstall", "onEnable", "onDisable", "onUpgrade", "onUninstall"] as const;

/** In-memory hooks for every module: they record each call and throw for the ones listed in `failing` ("<id>.<hook>"). */
class Hooks {
  readonly calls: { moduleId: string; hook: string; context: HookContext }[] = [];
  readonly failing = new Set<string>();

  readonly load: HookLoader = async (manifest: ModuleManifest): Promise<ModuleHooks> =>
    Object.fromEntries(
      HOOK_NAMES.map((hook) => [
        hook,
        async (context: HookContext) => {
          this.calls.push({ moduleId: manifest.id, hook, context });
          if (this.failing.has(`${manifest.id}.${hook}`)) throw new Error(`boom in ${hook}`);
        },
      ]),
    );

  of(moduleId: string): string[] {
    return this.calls.filter((call) => call.moduleId === moduleId).map((call) => call.hook);
  }

  last(moduleId: string, hook: string): HookContext {
    return this.calls.filter((call) => call.moduleId === moduleId && call.hook === hook).at(-1)!.context;
  }
}

const test = (name: string, run: (box: Sandbox, hooks: Hooks) => Promise<void>) =>
  it(name, async (t) => {
    if (!pool) return t.skip(skipReason);
    const box = new Sandbox(pool);
    try {
      await run(box, new Hooks());
    } finally {
      await box.cleanup();
    }
  });

/** A service over the sandbox's current manifests; platform-unsupported packages are admitted so they can be refused. */
const serviceFor = (box: Sandbox, hooks: Hooks, options: { lockTimeoutMs?: number } = {}) =>
  new LifecycleService(pool!, box.registry({ allowUnsupportedPlatform: true }), { loadHooks: hooks.load, lockPollMs: 20, ...options });

const events = async (id: string) =>
  (await readEvents(pool!, id)).map((e) => [e.action, e.fromState, e.toState, e.version, e.outcome, e.detail] as const);

const stateOf = async (id: string) => (await readStates(pool!)).get(id);
const schemaExists = async (schema: string) =>
  (await pool!.query("select 1 from information_schema.schemata where schema_name = $1", [schema])).rowCount === 1;
const historyOf = async (id: string) =>
  (await pool!.query("select filename from core.schema_migrations where module_id = $1 order by filename", [id])).rows.map((r) => r.filename as string);

const rejection = async (work: Promise<unknown>): Promise<unknown> => work.then(() => assert.fail("expected the action to be refused or to fail"), (e: unknown) => e);

/** A module with one table and one row, so that data kept or dropped is observable. */
function withData(mod: Throwaway): Throwaway {
  mod.write("0001_create_items.sql", "create table items (name text not null); insert into items values ('kept');");
  return mod;
}
const rowCount = async (mod: Throwaway) => (await pool!.query(`select count(*)::int as n from "${mod.manifest.schema}".items`)).rows[0].n as number;

describe("LifecycleService: the full journey", () => {
  test("install, disable, enable, upgrade and uninstall (keep, then purge) are all audited", async (box, hooks) => {
    const mod = withData(box.add());
    const id = mod.manifest.id;

    const installed = await serviceFor(box, hooks).install(id);
    assert.deepEqual([installed.from, installed.to, installed.version], ["available", "enabled", "1.0.0"]);
    assert.deepEqual(await stateOf(id), { id, state: "enabled", installedVersion: "1.0.0" });
    assert.equal(await rowCount(mod), 1);
    assert.deepEqual(await historyOf(id), ["0001_create_items.sql"]);
    assert.deepEqual(hooks.of(id), ["onInstall", "onEnable"]);

    await serviceFor(box, hooks).disable(id);
    assert.equal((await stateOf(id))?.state, "disabled");
    assert.equal(await rowCount(mod), 1, "disable keeps all data");

    await serviceFor(box, hooks).enable(id);
    assert.equal((await stateOf(id))?.state, "enabled");

    mod.manifest = { ...mod.manifest, version: "1.1.0" };
    mod.write("0002_add_column.sql", "alter table items add column note text;");
    const upgraded = await serviceFor(box, hooks).upgrade(id);
    assert.deepEqual([upgraded.previousVersion, upgraded.version], ["1.0.0", "1.1.0"]);
    assert.deepEqual(await stateOf(id), { id, state: "enabled", installedVersion: "1.1.0" });
    assert.deepEqual(await historyOf(id), ["0001_create_items.sql", "0002_add_column.sql"]);

    hooks.calls.length = 0;
    await serviceFor(box, hooks).uninstall(id, "keep");
    assert.equal(await stateOf(id), undefined);
    assert.deepEqual(hooks.of(id), ["onDisable", "onUninstall"], "an enabled module is disabled first");
    assert.equal(hooks.last(id, "onUninstall").mode, "keep");
    assert.equal(await rowCount(mod), 1, "keep leaves the schema and its data");
    assert.equal((await historyOf(id)).length, 2, "keep leaves the migration history");
    const kept = (await serviceFor(box, hooks).list()).find((m) => m.id === id);
    assert.deepEqual([kept?.status, kept?.dataRetained], ["available", true]);

    await serviceFor(box, hooks).install(id);
    assert.equal(await rowCount(mod), 1, "installing again finds the kept data and applies nothing new");
    await serviceFor(box, hooks).disable(id);
    await serviceFor(box, hooks).uninstall(id, "purge");
    assert.equal(await schemaExists(mod.manifest.schema), false, "purge drops the schema");
    assert.deepEqual(await historyOf(id), [], "purge removes the migration history");
    assert.equal((await serviceFor(box, hooks).list()).find((m) => m.id === id)?.dataRetained, false);

    assert.deepEqual(await events(id), [
      ["install", "available", "enabled", "1.0.0", "ok", null],
      ["disable", "enabled", "disabled", "1.0.0", "ok", null],
      ["enable", "disabled", "enabled", "1.0.0", "ok", null],
      ["upgrade", "enabled", "enabled", "1.1.0", "ok", null],
      ["uninstall", "enabled", "available", "1.1.0", "ok", "keep"],
      ["install", "available", "enabled", "1.1.0", "ok", null],
      ["disable", "enabled", "disabled", "1.1.0", "ok", null],
      ["uninstall", "disabled", "available", "1.1.0", "ok", "purge"],
    ]);
  });

  test("hooks receive the module id, versions, the pool and, for uninstall, the mode", async (box, hooks) => {
    const mod = withData(box.add());
    const id = mod.manifest.id;
    await serviceFor(box, hooks).install(id);
    assert.deepEqual({ ...hooks.last(id, "onInstall"), db: undefined }, { moduleId: id, version: "1.0.0", db: undefined });
    assert.equal(hooks.last(id, "onEnable").db, pool);

    mod.manifest = { ...mod.manifest, version: "2.0.0" };
    await serviceFor(box, hooks).upgrade(id);
    const upgrade = hooks.last(id, "onUpgrade");
    assert.deepEqual([upgrade.previousVersion, upgrade.version], ["1.0.0", "2.0.0"]);
  });

  test("upgrading to the installed version does nothing and records nothing", async (box, hooks) => {
    const mod = withData(box.add());
    await serviceFor(box, hooks).install(mod.manifest.id);
    const result = await serviceFor(box, hooks).upgrade(mod.manifest.id);
    assert.equal(result.noop, true);
    assert.equal((await events(mod.manifest.id)).length, 1);
    assert.deepEqual(hooks.of(mod.manifest.id), ["onInstall", "onEnable"]);
  });

  test("a disabled module can be upgraded and stays disabled", async (box, hooks) => {
    const mod = withData(box.add());
    const id = mod.manifest.id;
    await serviceFor(box, hooks).install(id);
    await serviceFor(box, hooks).disable(id);
    mod.manifest = { ...mod.manifest, version: "1.0.1" };
    await serviceFor(box, hooks).upgrade(id);
    assert.deepEqual(await stateOf(id), { id, state: "disabled", installedVersion: "1.0.1" });
  });
});

describe("LifecycleService: refusals", () => {
  test("uninstall without a mode is refused and changes nothing", async (box, hooks) => {
    const mod = withData(box.add());
    const id = mod.manifest.id;
    await serviceFor(box, hooks).install(id);
    const error = await rejection(serviceFor(box, hooks).uninstall(id));
    assert.ok(error instanceof LifecycleRefusedError);
    assert.equal(error.code, "mode_required");
    assert.equal(error.moduleId, id);
    assert.equal(error.action, "uninstall");
    assert.equal((await stateOf(id))?.state, "enabled");
    assert.equal(await rowCount(mod), 1);
    assert.equal((await events(id)).length, 1, "a refusal is not a transition and is not audited");
    assert.deepEqual(hooks.of(id), ["onInstall", "onEnable"]);
  });

  test("disable and uninstall are refused while a dependent exists, naming it", async (box, hooks) => {
    const base = withData(box.add());
    const app = withData(box.add({ [base.manifest.id]: "*" }));
    const service = () => serviceFor(box, hooks);
    await service().install(base.manifest.id);
    await service().install(app.manifest.id);

    const disable = await rejection(service().disable(base.manifest.id));
    assert.ok(disable instanceof LifecycleRefusedError);
    assert.equal(disable.code, "has_enabled_dependents");
    assert.deepEqual(disable.related, [app.manifest.id]);
    assert.ok(disable.message.includes(app.manifest.id));

    await service().disable(app.manifest.id);
    await service().disable(base.manifest.id);
    const uninstall = await rejection(service().uninstall(base.manifest.id, "purge"));
    assert.ok(uninstall instanceof LifecycleRefusedError);
    assert.equal(uninstall.code, "has_installed_dependents");
    assert.deepEqual(uninstall.related, [app.manifest.id]);
    assert.equal(await schemaExists(base.manifest.schema), true);

    await service().uninstall(app.manifest.id, "purge");
    await service().uninstall(base.manifest.id, "purge");
    assert.equal(await stateOf(base.manifest.id), undefined);
  });

  test("install is refused until the dependency is enabled", async (box, hooks) => {
    const base = withData(box.add());
    const app = withData(box.add({ [base.manifest.id]: "*" }));
    const error = await rejection(serviceFor(box, hooks).install(app.manifest.id));
    assert.ok(error instanceof LifecycleRefusedError);
    assert.equal(error.code, "dependency_not_enabled");
    assert.deepEqual(error.related, [base.manifest.id]);
    assert.equal(await schemaExists(app.manifest.schema), false, "nothing was migrated");
  });

  test("a module whose platform range does not match the SDK is refused at install", async (box, hooks) => {
    const mod = withData(box.add());
    mod.manifest = { ...mod.manifest, platform: "^9.0.0" };
    const error = await rejection(serviceFor(box, hooks).install(mod.manifest.id));
    assert.ok(error instanceof LifecycleRefusedError);
    assert.equal(error.code, "platform_unsupported");
    assert.equal(await schemaExists(mod.manifest.schema), false);
    assert.equal(await stateOf(mod.manifest.id), undefined);
    assert.deepEqual(await events(mod.manifest.id), []);
  });

  test("the core and unknown modules are refused", async (box, hooks) => {
    const service = serviceFor(box, hooks);
    const core = await rejection(service.install("core"));
    assert.ok(core instanceof LifecycleRefusedError);
    assert.equal(core.code, "core_protected");
    const unknown = await rejection(service.enable("ghost"));
    assert.ok(unknown instanceof LifecycleRefusedError);
    assert.equal(unknown.code, "unknown_module");
  });
});

describe("LifecycleService: failures", () => {
  test("a hook that throws at install leaves no row, audits the failure, and a retry succeeds", async (box, hooks) => {
    const mod = withData(box.add());
    const id = mod.manifest.id;
    hooks.failing.add(`${id}.onEnable`);

    const error = await rejection(serviceFor(box, hooks).install(id));
    assert.ok(error instanceof LifecycleStepError);
    assert.deepEqual([error.moduleId, error.action, error.step], [id, "install", "onEnable"]);
    assert.match(error.message, new RegExp(`install of module "${id}" failed at step "onEnable": boom in onEnable`));
    assert.match((error.cause as Error).message, /boom in onEnable/);

    assert.equal(await stateOf(id), undefined, "core.modules is unchanged");
    assert.deepEqual(await events(id), [["install", "available", "enabled", "1.0.0", "failed", "onEnable: boom in onEnable"]]);
    assert.deepEqual(await historyOf(id), ["0001_create_items.sql"], "migrations already committed stay applied");
    assert.equal(await rowCount(mod), 1);

    hooks.failing.clear();
    hooks.calls.length = 0;
    await serviceFor(box, hooks).install(id);
    assert.equal((await stateOf(id))?.state, "enabled");
    assert.deepEqual(hooks.of(id), ["onInstall", "onEnable"], "hooks run again on retry");
    assert.equal(await rowCount(mod), 1, "the committed migration was not applied twice");
    assert.deepEqual((await events(id)).map((e) => e[4]), ["failed", "ok"]);
  });

  test("a migration that fails at install keeps the earlier files, leaves no row, and a fixed retry succeeds", async (box, hooks) => {
    const mod = withData(box.add());
    const id = mod.manifest.id;
    mod.write("0002_broken.sql", "select * from does_not_exist;");

    const error = await rejection(serviceFor(box, hooks).install(id));
    assert.ok(error instanceof LifecycleStepError);
    assert.equal(error.step, "migrations");
    assert.match(error.message, new RegExp(`install of module "${id}" failed at step "migrations": .*0002_broken\\.sql failed`));
    assert.equal(await stateOf(id), undefined);
    assert.deepEqual(await historyOf(id), ["0001_create_items.sql"]);
    assert.deepEqual(hooks.of(id), [], "no hook runs before the migrations are done");
    const [failed] = await events(id);
    assert.deepEqual(failed?.slice(0, 5), ["install", "available", "enabled", "1.0.0", "failed"]);
    assert.match(failed?.[5] ?? "", /^migrations: .*does_not_exist/);

    mod.write("0002_broken.sql", "alter table items add column note text;");
    await serviceFor(box, hooks).install(id);
    assert.deepEqual(await stateOf(id), { id, state: "enabled", installedVersion: "1.0.0" });
    assert.deepEqual(await historyOf(id), ["0001_create_items.sql", "0002_broken.sql"]);
  });

  test("a failing upgrade keeps the old version and its committed migrations, and can be retried", async (box, hooks) => {
    const mod = withData(box.add());
    const id = mod.manifest.id;
    await serviceFor(box, hooks).install(id);
    mod.manifest = { ...mod.manifest, version: "1.1.0" };
    mod.write("0002_more.sql", "create table more (x int);");
    hooks.failing.add(`${id}.onUpgrade`);

    const error = await rejection(serviceFor(box, hooks).upgrade(id));
    assert.ok(error instanceof LifecycleStepError);
    assert.deepEqual([error.action, error.step], ["upgrade", "onUpgrade"]);
    assert.deepEqual(await stateOf(id), { id, state: "enabled", installedVersion: "1.0.0" });
    assert.deepEqual(await historyOf(id), ["0001_create_items.sql", "0002_more.sql"]);
    assert.deepEqual((await events(id)).at(-1), ["upgrade", "enabled", "enabled", "1.1.0", "failed", "onUpgrade: boom in onUpgrade"]);

    hooks.failing.clear();
    await serviceFor(box, hooks).upgrade(id);
    assert.equal((await stateOf(id))?.installedVersion, "1.1.0");
  });

  test("a failing enable or disable hook leaves the state as it was", async (box, hooks) => {
    const mod = withData(box.add());
    const id = mod.manifest.id;
    await serviceFor(box, hooks).install(id);

    hooks.failing.add(`${id}.onDisable`);
    const disable = await rejection(serviceFor(box, hooks).disable(id));
    assert.ok(disable instanceof LifecycleStepError && disable.step === "onDisable");
    assert.equal((await stateOf(id))?.state, "enabled");

    hooks.failing.clear();
    await serviceFor(box, hooks).disable(id);
    hooks.failing.add(`${id}.onEnable`);
    const enable = await rejection(serviceFor(box, hooks).enable(id));
    assert.ok(enable instanceof LifecycleStepError && enable.step === "onEnable");
    assert.equal((await stateOf(id))?.state, "disabled");
    assert.deepEqual((await events(id)).map((e) => [e[0], e[4]]), [["install", "ok"], ["disable", "failed"], ["disable", "ok"], ["enable", "failed"]]);
  });

  test("a failing uninstall hook keeps the row, the schema and the history, even with purge", async (box, hooks) => {
    const mod = withData(box.add());
    const id = mod.manifest.id;
    await serviceFor(box, hooks).install(id);
    hooks.failing.add(`${id}.onUninstall`);

    const error = await rejection(serviceFor(box, hooks).uninstall(id, "purge"));
    assert.ok(error instanceof LifecycleStepError);
    assert.deepEqual([error.action, error.step], ["uninstall", "onUninstall"]);
    assert.equal((await stateOf(id))?.state, "enabled", "the module stays enabled although onDisable already ran");
    assert.equal(await rowCount(mod), 1);
    assert.equal((await historyOf(id)).length, 1);
    assert.deepEqual((await events(id)).at(-1), ["uninstall", "enabled", "available", "1.0.0", "failed", "onUninstall: boom in onUninstall"]);

    hooks.failing.clear();
    await serviceFor(box, hooks).uninstall(id, "purge");
    assert.equal(await schemaExists(mod.manifest.schema), false);
  });

  test("a failing onDisable during uninstall stops before onUninstall", async (box, hooks) => {
    const mod = withData(box.add());
    const id = mod.manifest.id;
    await serviceFor(box, hooks).install(id);
    hooks.failing.add(`${id}.onDisable`);
    hooks.calls.length = 0;
    const error = await rejection(serviceFor(box, hooks).uninstall(id, "keep"));
    assert.ok(error instanceof LifecycleStepError && error.step === "onDisable");
    assert.deepEqual(hooks.of(id), ["onDisable"]);
    assert.equal((await stateOf(id))?.state, "enabled");
  });

  test("a hook entry that cannot be loaded fails the action at the load step", async (box) => {
    const mod = withData(box.add());
    const id = mod.manifest.id;
    const service = new LifecycleService(pool!, box.registry(), {
      loadHooks: async () => {
        throw new Error("cannot import ./hooks.ts");
      },
    });
    const error = await rejection(service.install(id));
    assert.ok(error instanceof LifecycleStepError);
    assert.equal(error.step, "load hooks");
    assert.equal(await stateOf(id), undefined);
    assert.equal(await schemaExists(mod.manifest.schema), false, "nothing is migrated when the hooks cannot be loaded");
    assert.equal((await events(id)).at(-1)?.[4], "failed");
  });
});

describe("LifecycleService: concurrency", () => {
  test("two installs of the same module do not interleave: one wins, the other is refused", async (box, hooks) => {
    const mod = withData(box.add());
    const id = mod.manifest.id;
    const results = await Promise.allSettled([serviceFor(box, hooks).install(id), serviceFor(box, hooks).install(id)]);

    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    assert.ok(refused.reason instanceof LifecycleRefusedError);
    assert.equal(refused.reason.code, "already_installed");
    assert.deepEqual(hooks.of(id), ["onInstall", "onEnable"]);
    assert.equal((await events(id)).length, 1);
  });

  test("actions on different modules both complete, one after the other", async (box, hooks) => {
    const first = withData(box.add());
    const second = withData(box.add());
    await Promise.all([serviceFor(box, hooks).install(first.manifest.id), serviceFor(box, hooks).install(second.manifest.id)]);
    assert.equal((await stateOf(first.manifest.id))?.state, "enabled");
    assert.equal((await stateOf(second.manifest.id))?.state, "enabled");
  });

  test("waits for a held lock only up to the timeout, then fails without touching anything", async (box, hooks) => {
    const mod = withData(box.add());
    const holder = await pool!.connect();
    try {
      await holder.query("select pg_advisory_lock(hashtext($1))", [MIGRATION_LOCK_NAME]);
      const started = Date.now();
      const error = await rejection(serviceFor(box, hooks, { lockTimeoutMs: 200 }).install(mod.manifest.id));
      assert.ok(error instanceof LifecycleStepError);
      assert.equal(error.step, "lock");
      assert.match(error.message, new RegExp(`install of module "${mod.manifest.id}" failed at step "lock": could not acquire the migration lock within 200 ms`));
      assert.ok(Date.now() - started < 3000);
    } finally {
      await holder.query("select pg_advisory_unlock(hashtext($1))", [MIGRATION_LOCK_NAME]);
      holder.release();
    }
    assert.equal(await stateOf(mod.manifest.id), undefined);
    assert.deepEqual(await events(mod.manifest.id), [], "no action ran, so nothing is audited");
  });
});

describe("LifecycleService: list", () => {
  test("shows every module on disk plus orphaned rows, with the derived status", async (box, hooks) => {
    const available = withData(box.add());
    const enabled = withData(box.add());
    const disabled = withData(box.add());
    const outdated = withData(box.add());
    const kept = withData(box.add());
    const service = () => serviceFor(box, hooks);
    await service().install(enabled.manifest.id);
    await service().install(disabled.manifest.id);
    await service().disable(disabled.manifest.id);
    await service().install(outdated.manifest.id);
    await service().install(kept.manifest.id);
    await service().uninstall(kept.manifest.id, "keep");
    outdated.manifest = { ...outdated.manifest, version: "1.2.0" };
    const orphan = `t-orphan-${enabled.manifest.id.slice(2)}`;
    await pool!.query("insert into core.modules (id, state, installed_version) values ($1, 'enabled', '0.5.0')", [orphan]);

    try {
      const listed = await service().list();
      const by = (id: string) => listed.find((m) => m.id === id);
      assert.equal(by("core"), undefined, "the core is not a manageable module");
      assert.deepEqual(by(available.manifest.id), { id: available.manifest.id, status: "available", packageVersion: "1.0.0", upgradePending: false, orphaned: false, dataRetained: false });
      assert.equal(by(enabled.manifest.id)?.status, "enabled");
      assert.equal(by(disabled.manifest.id)?.status, "disabled");
      assert.deepEqual([by(outdated.manifest.id)?.upgradePending, by(outdated.manifest.id)?.installedVersion, by(outdated.manifest.id)?.packageVersion], [true, "1.0.0", "1.2.0"]);
      assert.deepEqual([by(kept.manifest.id)?.status, by(kept.manifest.id)?.dataRetained], ["available", true]);
      assert.deepEqual(by(orphan), { id: orphan, status: "enabled", installedVersion: "0.5.0", upgradePending: false, orphaned: true, dataRetained: false });
      const ids = listed.map((m) => m.id);
      assert.deepEqual(ids, [...ids].sort(), "sorted by id");
    } finally {
      await pool!.query("delete from core.modules where id = $1", [orphan]);
    }
  });

  test("works before anything has been installed or migrated", async (box, hooks) => {
    const mod = box.add();
    const listed = await serviceFor(box, hooks).list();
    assert.equal(listed.find((m) => m.id === mod.manifest.id)?.status, "available");
  });
});

describe("fileHookLoader", () => {
  const withModulesDir = async (run: (dir: string) => Promise<void>) => {
    const dir = mkdtempSync(join(tmpdir(), "epnexo-hooks-"));
    try {
      await run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const manifestOf = (hooks?: string): ModuleManifest => ({
    id: "alpha", version: "1.0.0", name: "alpha", platform: "^0.1.0", dependsOn: {}, schema: "alpha", migrationsDir: "migrations", nav: [],
    ...(hooks === undefined ? {} : { hooks }),
  });

  it("imports the entry relative to the module directory and returns its hooks", async () => {
    await withModulesDir(async (dir) => {
      mkdirSync(join(dir, "alpha"));
      writeFileSync(join(dir, "alpha", "hooks.ts"), "export const onInstall = () => undefined;\nexport const unrelated = 1;\n");
      const hooks = await fileHookLoader(dir)(manifestOf("./hooks.ts"));
      assert.equal(typeof hooks?.onInstall, "function");
      assert.equal(hooks?.onEnable, undefined);
    });
  });

  it("returns nothing for a module without hooks", async () => {
    assert.equal(await fileHookLoader("/nonexistent")(manifestOf()), undefined);
  });

  it("refuses a hook export that is not a function, naming the hook and the file", async () => {
    await withModulesDir(async (dir) => {
      mkdirSync(join(dir, "alpha"));
      writeFileSync(join(dir, "alpha", "hooks.ts"), "export const onInstall = 'nope';\n");
      await assert.rejects(fileHookLoader(dir)(manifestOf("./hooks.ts")), /"onInstall".*hooks\.ts.*must be a function/);
    });
  });

  it("fails when the entry does not exist", async () => {
    await withModulesDir(async (dir) => {
      await assert.rejects(fileHookLoader(dir)(manifestOf("./missing.ts")));
    });
  });
});
