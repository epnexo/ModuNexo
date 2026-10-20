# Feature: events and realtime (ADR-001, capability 4)

Objective: a module publishes typed events inside its own transaction; other modules react to them through jobs; a signed-in browser follows them live over a server-sent-events stream that can resume from a cursor.
Branch: feat/events-realtime (from main). Delivery strategy: ask-on-risk; the owner wants only `main` on GitHub, so the branch stays local and is fast-forwarded into `main`; no push without the owner. Test runner: `npm test` (node:test via tsx), `npm run typecheck`.

## Specs

- S1. Manifest: `events: [{ name, permission? }]` registers the event types a module publishes. `name` is dotted lowercase
  segments (the `permissions` key rules); the full type is `<moduleId>.<name>` and the name is unique in the module.
  `permission`, when present, is one of the module's declared permissions. An event without `permission` is never sent to a
  browser. `subscriptions: [{ event, job }]` makes the platform run the module's own declared job for each event of that
  type; `event` is a full type whose owner is the module itself or a module in `dependsOn`; `job` is declared in `jobs`.
  Unknown fields are refused. [decision]
- S2. Storage: `core.events` holds one row per event: a bigint `id` that is the cursor, module, full type, JSON payload (at
  most 16 KiB) and `created_at`. [decision]
- S3. Publish: the SDK exports `publishEvent(moduleId, name, payload?, { tx? })`. The module must be enabled and have declared
  the name. With `tx` (the handle `getDb(...).transaction` gives) the event is written in the caller's transaction, so it
  exists exactly when the caller's data does and is announced only after commit; without it, it is published in its own
  transaction. It resolves to `{ id }`. [decision]
- S4. Order: events become visible in `id` order. Publishing takes a transaction-scoped advisory lock before the id is
  assigned, so a lower id never commits after a higher one and a cursor cannot skip an event. Publishers serialise until
  commit; keep transactions short (documented). [decision]
- S5. Fan-out: in the publisher's transaction, for every ENABLED module with a subscription to the event type, the platform
  enqueues the subscribed job with the payload `{ event: { id, type, payload, createdAt } }`. A disabled subscriber gets
  nothing (it does not catch up later). The job runs, retries and dies as any job (capability 3). [decision]
- S6. Stream: `GET /api/events?types=<t1,t2>&after=<cursor>` (and the `Last-Event-ID` header) answers
  `text/event-stream` to a signed-in browser. It sends, in order, the retained events after the cursor and then new ones as they
  happen, each as `id: <id>`, `event: <type>`, `data: <JSON of {id, type, payload, createdAt}>`. A comment line every 20 s
  keeps it alive. Only types whose event declares a `permission` that the viewer holds are sent; `types` filters further
  (at most 20 types, each must be a registered type). If the cursor is older than the oldest retained event the stream
  starts with `event: reset` and then continues from the oldest. Past 200 open streams in one process the answer is 503.
  [decision]
- S7. Cross-process: events published by the worker or by another web process reach every stream. The web process keeps one
  dedicated connection that LISTENs on a channel, reads the new rows after the last id it has seen when told, and also
  re-reads every 5 s and after any reconnect, so a lost notification delays an event but never drops it. [decision]
- S8. CLI: `events list [module] [--type <t>] [--limit <n>] [--json]` (a payload is printed only with `--json`) and
  `events publish <module> <name> [--payload <json>]`. Refusals exit 3, usage errors exit 2. [decision]
- S9. Lifecycle: `uninstall --purge` deletes the module's events. The worker deletes events older than 7 days (hourly).
  The install review lists a module's events and subscriptions.
- S10. Docs: README, the module skill, an ADR note.
- Not in this feature (follow-ups): a React hook for the stream; per-event delivery receipts for modules (the job queue is
  the receipt); replaying old events to a module that was disabled; subscribing to a module that is not in `dependsOn`;
  wildcard types; a stream health screen.

## Tasks

- [x] T1 (S1, S3 SDK side) manifest `events`/`subscriptions`, `publishEvent`, event-type helpers. Route: inline. Commit: 24c724a (RED observed)
- [x] T2 (S2, S3, S4, S5, S9 purge/prune) migration 0012, `EventService`, `JobService.enqueue` on a given executor, purge. Route: inline. Commit: 93bbb35, 3d53c13 (no RED before the code; the ordering test was shown to fail with the lock removed)
- [x] T3 (S3, S8, S9) register the publisher in web and worker, worker prune, CLI `events`. Route: inline. Commit: bd0ba47 (RED observed for the worker tests; the CLI tests were written first but not run before the code)
- [x] T4 (S6, S7) event hub (LISTEN, catch-up, poll), `/api/events`, gate, end-to-end. Route: inline. Commit: b3ff18e (hub), next commit (stream, route, e2e) (RED observed for the hub and stream tests; e2e written with the code)
- [x] T5 (S9 review, S10) install review, README, skill, ADR note. Route: inline. Commit: next commit (no RED for the review test: written together with the code)
- [ ] T6 full suite, independent verifier. Route: inline. Commit: pending

## Log

- L1 (2026-10-20, user, verbatim): "sigue con eventos y tiempo real"
- L2: Route declaration: all tasks inline; no writer trigger (tasks share SDK, core, CLI and web files). Mapping trigger fired
  once (explorer: jobs pattern, pool, web server, gate, purge, test helpers). Risk: concurrency (item 4: advisory lock,
  ordering, reconnects) and security (item 2: a permission filter decides what a browser may read) plus a new persisted
  table (additive), so an independent verifier runs at the end.
- L3: Decisions taken without asking, per the standing instruction: Postgres is the event log and the bus (LISTEN/NOTIFY plus a
  poll), events are announced inside the publisher's transaction so they appear only on commit, module-to-module delivery
  reuses the job queue (durable, retried), a browser sees an event only if the manifest ties it to a permission it holds
  (fail closed), subscribing requires `dependsOn` like the read-only SQL channel.
- L4: While running the job tests for T2 two worker tests failed on the unchanged baseline too: they inserted rows with the
  database clock while the test clock was fixed at 2026-10-20T12:00:00Z, so they passed only before that moment on the day they
  were written. The inserts now carry the fake clock (a time bomb of capability 3, fixed in 93bbb35). A third test raced the
  write of the last outcome under load and now waits for the worker to be idle (3d53c13).
- L5: A subscriber the platform refuses (a `JobError`, for instance a job the module no longer declares) is skipped so it cannot
  abort the publisher's transaction; `JobError` is raised before any statement, so the transaction stays usable.
- L6: Additions beyond the first draft of the specs, same feature: the stream starts with `event: reset` also when the client is
  more than 1000 events behind (it is not replayed), and a client with 500 frames queued is disconnected; a viewer who may follow
  no event gets 403; the hub's starting position is taken under the publishers' lock (`settledPosition`) so an event that
  was mid-commit cannot be skipped. The ordering test was shown to fail with the lock removed (2 of 3 runs).
- L7: Observed: full e2e file 42/42 on a production build, including a route publishing inside a module transaction (rollback
  removes row and event), resume by `Last-Event-ID`, a reset for a cursor from another log, and a worker process publishing
  an event that an open stream receives while the subscribed job runs.
