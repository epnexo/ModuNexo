# Feature: background jobs (ADR-001, capability 3)

Objective: a module can declare jobs, enqueue them from its request code, and have a separate worker process run them with retries, timeouts and a schedule.
Branch: feat/background-jobs (stacked on feat/service-tokens). Delivery strategy: ask-on-risk (no remote work without the owner). Test runner: `npm test` (node:test via tsx), `npm run typecheck`.

## Specs

- S1. Manifest: a module declares `jobs: [{ name, entry, every?, timeoutSeconds?, maxAttempts? }]`. `name` follows the
  `permissions` key rules and is unique in the module; `entry` is a `./` path to a file whose default export is
  `async (ctx) => void`; `every` is an interval `"<n>s|m|h|d"` (at least 10 seconds, at most 30 days); `timeoutSeconds`
  1 to 3600 (default 60); `maxAttempts` 1 to 20 (default 5). Unknown fields are refused. [decision]
- S2. Storage: `core.jobs` holds one row per job: module, name, JSON payload (at most 64 KiB), status
  (`queued`, `running`, `succeeded`, `dead`, `cancelled`), `run_at`, attempts, limits, lease, the worker that holds it,
  the last error (message only, cut at 1000 characters), an optional `dedupe_key`, who enqueued it, and timestamps. [decision]
- S3. Enqueue: the SDK exports `enqueueJob(moduleId, name, payload?, { runAt?, delaySeconds?, dedupeKey? })`, which works
  wherever the platform registered an enqueuer (the web app and the worker). The job must be declared by the module and
  the module must be enabled. With a `dedupeKey`, a second enqueue while a job with that key is `queued` or `running`
  returns the existing job (`deduplicated: true`) instead of adding one. [decision]
- S4. Worker: `modunexo worker [--concurrency <n>] [--poll-ms <n>]` runs until SIGINT or SIGTERM. Each tick it recovers
  jobs whose lease expired, makes sure every scheduled job has its next run, claims due jobs of ENABLED modules with
  `for update skip locked` (several workers are safe), and runs them. Jobs of a disabled module stay queued. [decision]
- S5. Execution: the handler is loaded from the module folder, gets `{ moduleId, jobName, jobId, attempt, payload, signal }`,
  and may use `getDb` and `getSetting` as in a request. The signal aborts at `timeoutSeconds`; a handler that ignores it is
  still marked failed at the timeout (it cannot be killed; documented). [decision]
- S6. Retry: a failure re-queues the job with a delay of 10 s doubling per attempt, capped at 1 h, until `maxAttempts`;
  then the job is `dead`. A worker that dies mid-job leaves a lease that expires (`timeoutSeconds` + 30 s); the job is
  recovered, with that attempt counted. A finished job is never overwritten by a stale worker. [decision]
- S7. Schedule: a job with `every` always has exactly one active run: the next one is queued `every` after the previous
  finished (fixed delay, not fixed rate), even when the previous went `dead`. Races between workers cannot make two. [decision]
- S8. Shutdown: on the first signal the worker stops claiming and waits up to 30 s for running jobs; what is left keeps its
  lease and is recovered later. Exit code 0 on a clean stop.
- S9. CLI: `jobs list [module] [--status <s>] [--json]`, `jobs enqueue <module> <name> [--payload <json>] [--delay-seconds <n>]
  [--dedupe-key <k>]`, `jobs cancel <id>` (queued only), `jobs retry <id>` (dead only, resets attempts). `list` never prints
  a payload except with `--json`. Refusals exit 3, usage errors exit 2. [decision]
- S10. Lifecycle: `uninstall --purge` deletes the module's jobs. Finished jobs older than 14 days are pruned by the worker.
  The install review lists a module's jobs and schedules.
- S11. Deployment and docs: a `worker` service in docker-compose, README, the module skill, ADR note.
- Not in this feature (follow-ups): cron expressions (only intervals); per-job concurrency limits; a jobs screen in the
  web app; hot reload of handler code (restart the worker after upgrading a module); a worker health endpoint.

## Tasks

- [ ] T1 (S1, S3 SDK side) manifest `jobs`, handler types, `enqueueJob` and its registration point in the SDK. Route: inline. Commit: pending
- [ ] T2 (S2, S3, S6, S7, S10 purge/prune) migration 0011, `JobService`, purge. Route: inline. Commit: pending
- [ ] T3 (S4, S5, S6, S8) `Worker`: tick, claim, run, timeout, shutdown, readers, handler loading. Route: inline. Commit: pending
- [ ] T4 (S4, S9) CLI `worker` and `jobs`. Route: inline. Commit: pending
- [ ] T5 (S3 web side, S10 review, S11) web registers the enqueuer, install review, compose, e2e on the fixture, docs. Route: inline. Commit: pending
- [ ] T6 full suite, independent verifier. Route: inline. Commit: pending

## Log

- L1 (2026-10-20, user, verbatim): "sigue con los trabajos en segundo plano"
- L2: Route declaration: all tasks inline; no writer trigger (tasks share SDK, core and CLI files). Mapping trigger fired once
  (explorer). Risk: concurrency (item 4: leases, races, async ordering) and a new persisted table (additive), so an independent
  verifier runs at the end.
- L3: Decisions taken without asking, per the standing instruction (L1 of public-routes): the worker is a separate process that
  loads module code under tsx (the CLI already does this for hooks), Postgres is the queue, intervals not cron,
  fixed-delay schedules, cooperative timeouts.
