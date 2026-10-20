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

- [x] T1 (S1, S3 SDK side) manifest `jobs`, handler types, `enqueueJob` and its registration point in the SDK. Route: inline. Commit: 5d6ff7c
- [x] T2 (S2, S3, S6, S7, S10 purge/prune) migration 0011, `JobService`, purge. Route: inline. Commit: aade8c1
- [x] T3 (S4, S5, S6, S8) `Worker`: tick, claim, run, timeout, shutdown, readers, handler loading. Route: inline. Commit: d413047
- [x] T4 (S4, S9) CLI `worker` and `jobs`. Route: inline. Commit: 8592330
- [x] T5 (S3 web side, S10 review, S11) web registers the enqueuer, install review, compose, e2e on the fixture, docs. Route: inline. Commit: ac89413
- [ ] T6 full suite, independent verifier. Route: inline. Commit: pending

## Log

- L1 (2026-10-20, user, verbatim): "sigue con los trabajos en segundo plano"
- L2: Route declaration: all tasks inline; no writer trigger (tasks share SDK, core and CLI files). Mapping trigger fired once
  (explorer). Risk: concurrency (item 4: leases, races, async ordering) and a new persisted table (additive), so an independent
  verifier runs at the end.
- L3: Decisions taken without asking, per the standing instruction (L1 of public-routes): the worker is a separate process that
  loads module code under tsx (the CLI already does this for hooks), Postgres is the queue, intervals not cron,
  fixed-delay schedules, cooperative timeouts.
- L4: RED observed for T1 (all new SDK tests failing on the missing export). T2, T3 and T4: the tests were written after or
  together with the code (the job service, the worker and the CLI were designed in one pass), so no RED was observed;
  the tests were then run until green and several of their first failures were mistakes in the tests, not in the code
  (a schedule queued during an unrelated test, a negative number swallowed by `parseArgs`, an assertion made one tick too early).
- L5: Beyond the plan, same feature: install review lists jobs and refuses a package whose job file is missing (e31f88f);
  end-to-end proof (07cbb8e) on a real production build: a route enqueues through the SDK (dedupe key holds, route stays
  behind the gate), a separate `worker` process runs the handler from the module folder and writes through `getDb`,
  SIGTERM exits 0, purge deletes the jobs. `docker compose --profile app config` validates the new `worker` service.
- L6: Known limits: intervals only (no cron); fixed-delay schedules; handler code is loaded once per worker process, so the worker
  is restarted after installing or upgrading a module; a handler that ignores its signal keeps running after its timeout;
  at-least-once delivery; no per-job concurrency limit, no jobs screen, no worker health endpoint.
- L7: Independent verifier found three blockers, all fixed in one batch and rechecked by tests that failed first (RED) and
  now pass, not by a second sweep: (1) the worker process did not exit after the grace period when a job never finished
  (the job's timeout timer kept it alive up to an hour); it now leaves at once, the lease is recovered by another worker, and
  `--grace-seconds` (1 to 300) was added; (2) a stop that arrived during a tick waited a whole poll interval (the abort
  listener never fires on an already aborted signal) and could still claim a batch; (3) `jobs retry` of a dead job
  whose dedupe key was taken (the next scheduled run) died with a raw pg error; it is now a refusal, exit 3.
  Also from the advisories: a payload with a NUL character is a `JobError`; the README documents clock sync, cross-module
  enqueue and the retry refusal; compose runs the worker with node directly (not through npm, so it gets the stop signal) and
  a 40 s stop period. Left as advisories: clocks come from the workers not the database, jobs of an enabled module without
  jobs in its manifest stay queued, a broken module folder fails every tick, a finished job wakes the loop only on the next
  poll when the tick was in progress.
- L8: The two job integration test files now use a scratch database each: recovering expired leases looks at the whole table
  and the tests set the clock by hand, so sharing a table made them fail only when run together.
