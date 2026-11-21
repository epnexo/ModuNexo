import type pg from "pg";
import type { ModuleManifest } from "@modunexo/sdk";
import type { Executor } from "../executor.ts";
import { DEFAULT_MAX_ATTEMPTS, DEFAULT_TIMEOUT_SECONDS } from "../jobs/service.ts";
import type { Registry } from "../registry.ts";

/**
 * What the database needs to know from a manifest to apply the rules of a module's login itself: the jobs the module
 * declares, with their limits, and the events its jobs subscribe to. Rewritten whole on every install and upgrade, in
 * one transaction, on the platform's connection.
 */
export async function syncDeclarations(client: pg.PoolClient, manifest: ModuleManifest): Promise<void> {
  try {
    await client.query("begin");
    await client.query("delete from core.module_jobs where module_id = $1", [manifest.id]);
    await client.query("delete from core.event_subscriptions where subscriber_module = $1", [manifest.id]);
    await client.query("delete from core.module_declared_events where module_id = $1", [manifest.id]);
    for (const event of manifest.events ?? []) {
      await client.query("insert into core.module_declared_events (module_id, name) values ($1, $2) on conflict do nothing", [manifest.id, event.name]);
    }
    for (const job of manifest.jobs ?? []) {
      await client.query("insert into core.module_jobs (module_id, name, max_attempts, timeout_seconds) values ($1, $2, $3, $4)", [
        manifest.id,
        job.name,
        job.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        job.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
      ]);
    }
    for (const subscription of manifest.subscriptions ?? []) {
      await client.query("insert into core.event_subscriptions (subscriber_module, event_type, job_name) values ($1, $2, $3) on conflict do nothing", [
        manifest.id,
        subscription.event,
        subscription.job,
      ]);
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  }
}

/** Removes what `syncDeclarations` wrote for a module, when it is purged. */
export async function clearDeclarations(client: Pick<pg.PoolClient, "query">, moduleId: string): Promise<void> {
  await client.query("delete from core.module_jobs where module_id = $1", [moduleId]);
  await client.query("delete from core.event_subscriptions where subscriber_module = $1", [moduleId]);
  await client.query("delete from core.module_declared_events where module_id = $1", [moduleId]);
}

const key = (parts: (string | number)[]) => parts.join("\u0001");

/**
 * Compares the tables with what the registry says, for the enabled modules. An empty list means they agree. A
 * difference means a manifest changed without going through an install or upgrade, and jobs would be lost silently,
 * so the caller refuses to start rather than carry on.
 */
export async function checkDeclarations(db: Executor, registry: Registry): Promise<string[]> {
  const enabled = (await db.query("select id from core.modules where state = 'enabled'")).rows.map((row) => row.id as string);
  const wantedJobs = new Set<string>();
  const wantedSubs = new Set<string>();
  const wantedEvents = new Set<string>();
  for (const id of enabled) {
    const manifest = registry.get(id);
    if (manifest === undefined) continue;
    for (const job of manifest.jobs ?? []) wantedJobs.add(key([id, job.name, job.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, job.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS]));
    for (const event of manifest.events ?? []) wantedEvents.add(key([id, event.name]));
    for (const sub of manifest.subscriptions ?? []) wantedSubs.add(key([id, sub.event, sub.job]));
  }
  const haveJobs = new Set(
    (await db.query("select module_id, name, max_attempts, timeout_seconds from core.module_jobs where module_id = any($1::text[])", [enabled])).rows.map((r) =>
      key([r.module_id as string, r.name as string, Number(r.max_attempts), Number(r.timeout_seconds)]),
    ),
  );
  const haveSubs = new Set(
    (await db.query("select subscriber_module, event_type, job_name from core.event_subscriptions where subscriber_module = any($1::text[])", [enabled])).rows.map((r) =>
      key([r.subscriber_module as string, r.event_type as string, r.job_name as string]),
    ),
  );
  const haveEvents = new Set(
    (await db.query("select module_id, name from core.module_declared_events where module_id = any($1::text[])", [enabled])).rows.map((r) => key([r.module_id as string, r.name as string])),
  );
  const problems: string[] = [];
  const show = (value: string) => value.split("\u0001").join("/");
  for (const item of wantedJobs) if (!haveJobs.has(item)) problems.push(`job ${show(item)} is declared but not in core.module_jobs`);
  for (const item of haveJobs) if (!wantedJobs.has(item)) problems.push(`job ${show(item)} is in core.module_jobs but not declared`);
  for (const item of wantedEvents) if (!haveEvents.has(item)) problems.push(`event ${show(item)} is declared but not in core.module_declared_events`);
  for (const item of haveEvents) if (!wantedEvents.has(item)) problems.push(`event ${show(item)} is in core.module_declared_events but not declared`);
  for (const item of wantedSubs) if (!haveSubs.has(item)) problems.push(`subscription ${show(item)} is declared but not in core.event_subscriptions`);
  for (const item of haveSubs) if (!wantedSubs.has(item)) problems.push(`subscription ${show(item)} is in core.event_subscriptions but not declared`);
  return problems;
}
