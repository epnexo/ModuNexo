import type pg from "pg";
import type { ModuleManifest } from "@epnexo/sdk";
import { CORE_MODULE_ID } from "../core-module.ts";
import { MODULES_DIR } from "../discovery.ts";
import { purgeModuleLocked } from "../purge.ts";
import { type Registry, compareIds } from "../registry.ts";
import { type MigrateOptions, migrateModuleLocked, withMigrationLock } from "../runner.ts";
import { LifecycleRefusedError, LifecycleStepError, type LifecycleStep } from "./errors.ts";
import { type HookContext, type HookLoader, type HookName, type ModuleHooks, fileHookLoader } from "./hooks.ts";
import { type ModuleStatus, deriveStatus } from "./status.ts";
import { appendEvent, deleteState, readSchemas, readStates, upsertState } from "./store.ts";
import { type TransitionPlan, type TransitionRequest, type UninstallMode, planTransition } from "./transitions.ts";

export interface LifecycleServiceOptions extends MigrateOptions {
  /** Produces a module's hooks. Default: import the manifest's `hooks` entry from `MODULES_DIR`. */
  loadHooks?: HookLoader;
}

/**
 * Performs lifecycle actions against Postgres: the rules come from `planTransition`, the schema work from
 * the migration runner and `purgeModule`, the state from `core.modules` and `core.module_events`.
 *
 * Failure semantics. An action is all-or-nothing as far as `core.modules` is concerned:
 * - The rules are checked first. A refusal throws `LifecycleRefusedError`; nothing runs, nothing is audited.
 * - Steps then run in order (install: migrations, onInstall, onEnable; enable: onEnable; disable: onDisable;
 *   upgrade: migrations, onUpgrade; uninstall: onDisable if enabled, onUninstall, then the purge for `purge`).
 *   The row is written, and the `ok` event appended, in one transaction after the last step.
 * - If any step throws, `core.modules` stays exactly as it was, a `failed` event is appended (its detail is
 *   `<step>: <message>`) and a `LifecycleStepError` naming module, action and step is thrown, with the
 *   original error as `cause`.
 * - Effects of steps that already succeeded are not undone: migration files are committed one by one and
 *   stay applied, and hooks that ran have run (an uninstall of an enabled module whose `onUninstall` fails
 *   leaves it enabled although `onDisable` ran). Retrying the same action is the way forward: applied
 *   migrations are skipped and hooks run again, so hooks should be idempotent.
 * - Failing to take the lock in time throws a `LifecycleStepError` at step `lock`; nothing ran, so nothing
 *   is audited.
 *
 * Locking. Every action holds the migration advisory lock, on one connection, for its whole duration, so
 * two actions (or an action and `migrate`) never interleave and the second one re-reads the state after
 * the first is done. The migration and purge steps run on that same connection through their `Locked`
 * variants instead of taking the lock again, which would wait on itself. Hooks run with the lock held.
 */
export class LifecycleService {
  readonly #pool: pg.Pool;
  readonly #registry: Registry;
  readonly #options: LifecycleServiceOptions;
  readonly #loadHooks: HookLoader;

  constructor(pool: pg.Pool, registry: Registry, options: LifecycleServiceOptions = {}) {
    this.#pool = pool;
    this.#registry = registry;
    this.#options = options;
    this.#loadHooks = options.loadHooks ?? fileHookLoader(MODULES_DIR);
  }

  install(moduleId: string): Promise<TransitionPlan> {
    return this.#run({ action: "install", moduleId });
  }

  enable(moduleId: string): Promise<TransitionPlan> {
    return this.#run({ action: "enable", moduleId });
  }

  disable(moduleId: string): Promise<TransitionPlan> {
    return this.#run({ action: "disable", moduleId });
  }

  upgrade(moduleId: string): Promise<TransitionPlan> {
    return this.#run({ action: "upgrade", moduleId });
  }

  /** `mode` is required by the rules; leaving it out is refused, there is no default. */
  uninstall(moduleId: string, mode?: UninstallMode): Promise<TransitionPlan> {
    return this.#run({ action: "uninstall", moduleId, mode });
  }

  /**
   * Every module the platform knows (packages on disk plus rows in `core.modules`) with its derived status,
   * sorted by id. The core is not listed: it is not something to install or remove. Reads without the lock.
   */
  async list(): Promise<ModuleStatus[]> {
    const [states, schemas] = await Promise.all([readStates(this.#pool), readSchemas(this.#pool)]);
    const manifests = new Map(this.#registry.all().filter((m) => m.id !== CORE_MODULE_ID).map((m) => [m.id, m]));
    const ids = [...new Set([...manifests.keys(), ...states.keys()])].sort(compareIds);
    return ids.map((id) => {
      const manifest = manifests.get(id);
      return deriveStatus({ id, manifest, installed: states.get(id), schemaExists: manifest !== undefined && schemas.has(manifest.schema) });
    });
  }

  async #run(request: TransitionRequest): Promise<TransitionPlan> {
    const { action, moduleId } = request;
    let started = false;
    try {
      return await withMigrationLock(this.#pool, this.#options, async (client) => {
        started = true;
        let step: LifecycleStep = "core migrations";
        let plan: TransitionPlan | undefined;
        try {
          // The lifecycle tables belong to the core's migrations, so make sure they exist before reading them.
          await migrateModuleLocked(client, this.#registry, CORE_MODULE_ID, this.#options);
          const decision = planTransition(request, await readStates(client), this.#registry);
          if (!decision.ok) throw new LifecycleRefusedError(moduleId, action, decision.refusal);
          plan = decision.plan;
          if (plan.noop) return plan;

          const manifest = this.#registry.get(moduleId)!;
          step = "load hooks";
          const hooks = await this.#loadHooks(manifest);
          await this.#steps(client, plan, manifest, hooks ?? {}, (next) => (step = next));
          step = "record";
          await this.#record(client, plan);
          return plan;
        } catch (error) {
          if (error instanceof LifecycleRefusedError) throw error;
          if (plan !== undefined) {
            // Best effort: if the connection is what failed, the audit row cannot be written either.
            await appendEvent(client, {
              moduleId,
              action,
              fromState: plan.from,
              toState: plan.to,
              version: plan.version,
              outcome: "failed",
              detail: `${step}: ${error instanceof Error ? error.message : String(error)}`,
            }).catch(() => undefined);
          }
          throw new LifecycleStepError(moduleId, action, step, error);
        }
      });
    } catch (error) {
      // withMigrationLock rejects before running the work only when the lock could not be taken.
      if (!started) throw new LifecycleStepError(moduleId, action, "lock", error);
      throw error;
    }
  }

  async #steps(client: pg.PoolClient, plan: TransitionPlan, manifest: ModuleManifest, hooks: ModuleHooks, at: (step: LifecycleStep) => void): Promise<void> {
    const context: HookContext = { moduleId: plan.moduleId, version: plan.version, db: this.#pool };
    if (plan.previousVersion !== undefined) context.previousVersion = plan.previousVersion;
    if (plan.mode !== undefined) context.mode = plan.mode;
    const hook = async (name: HookName): Promise<void> => {
      at(name);
      await hooks[name]?.(context);
    };
    const migrations = async (): Promise<void> => {
      at("migrations");
      await migrateModuleLocked(client, this.#registry, manifest.id, this.#options);
    };

    switch (plan.action) {
      case "install":
        await migrations();
        await hook("onInstall");
        await hook("onEnable");
        break;
      case "enable":
        await hook("onEnable");
        break;
      case "disable":
        await hook("onDisable");
        break;
      case "upgrade":
        await migrations();
        await hook("onUpgrade");
        break;
      case "uninstall":
        if (plan.disableFirst) await hook("onDisable");
        await hook("onUninstall");
        if (plan.mode === "purge") {
          at("purge");
          await purgeModuleLocked(client, this.#registry, manifest.id);
        }
        break;
    }
  }

  /** The new state and the `ok` event in one transaction, so the audit log and `core.modules` cannot disagree. */
  async #record(client: pg.PoolClient, plan: TransitionPlan): Promise<void> {
    try {
      await client.query("begin");
      if (plan.to === "available") {
        await deleteState(client, plan.moduleId);
      } else {
        await upsertState(client, { id: plan.moduleId, state: plan.to, installedVersion: plan.version });
      }
      await appendEvent(client, {
        moduleId: plan.moduleId,
        action: plan.action,
        fromState: plan.from,
        toState: plan.to,
        version: plan.version,
        outcome: "ok",
        detail: plan.mode ?? null,
      });
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    }
  }
}
