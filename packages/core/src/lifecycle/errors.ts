import type { LifecycleAction, Refusal, RefusalCode } from "./transitions.ts";

/** Where in an action a failure happened; the step names the hook, so `onEnable` means the module's own hook threw. */
export type LifecycleStep =
  | "lock"
  | "core migrations"
  | "load hooks"
  | "migrations"
  | "onInstall"
  | "onEnable"
  | "onDisable"
  | "onUpgrade"
  | "onUninstall"
  | "purge"
  | "record";

export class LifecycleError extends Error {
  constructor(
    message: string,
    readonly moduleId: string,
    readonly action: LifecycleAction,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The rules said no. Nothing was changed and nothing was audited: a refusal is not a transition. */
export class LifecycleRefusedError extends LifecycleError {
  readonly code: RefusalCode;
  readonly related: string[];

  constructor(moduleId: string, action: LifecycleAction, refusal: Refusal) {
    super(refusal.message, moduleId, action);
    this.code = refusal.code;
    this.related = refusal.related;
  }
}

/** An accepted action failed at `step`. The original error is the `cause`. */
export class LifecycleStepError extends LifecycleError {
  constructor(
    moduleId: string,
    action: LifecycleAction,
    readonly step: LifecycleStep,
    cause: unknown,
  ) {
    super(`${action} of module "${moduleId}" failed at step "${step}": ${cause instanceof Error ? cause.message : String(cause)}`, moduleId, action, { cause });
  }
}
