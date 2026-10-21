# Feature: status screen (what the platform is doing in the background)

Objective: an administrator can see, in the shell, what the background capabilities are doing (jobs, events, stored files, the model each module is set up to call) and can test a model's connection, without the command line.
Branch: feat/status-screen (from feat/install-without-downtime, so the chain into `main` stays linear). Delivery strategy: ask-on-risk; the owner wants only `main` on GitHub, so the branch stays local and is fast-forwarded into `main`; no push without the owner. Test runner: `npm test` (node:test via tsx), `npm run typecheck`. No rendering tests exist in this repository: logic lives in pure functions under `apps/web/src/server/` and is tested there, and the end-to-end file proves the page and the route on a real build.

## Specs

- S1. A shell page `/status` ("Status" in the sidebar) for administrators. With sign-in off the local operator is the administrator. Anyone
  else who opens it sees "Only an administrator can view the platform's status." and nothing is read. [decision: its own page, not a tab
  of Settings, because Settings is configuration and this is operation; the owner's words were "pantalla de estado"]
- S2. One concern at a time, as the menu rule says: tabs Jobs, Events, Files and Model. [decision]
- S3. Jobs: for each module that has jobs, how many are queued, running, succeeded, dead and cancelled; the newest 20 that are dead or are
  waiting for a retry, with module, job name, attempts out of maximum, when, and the last error as plain text cut to 200 characters. The
  payload is never read. A line says when jobs are due and nobody has taken them ("N jobs have been due for more than a minute: is the
  worker running? Start it with `npm run modunexo -- worker`"). [decision]
- S4. Events: the newest 50 (id, module, type, time), never a payload; a line says events are kept 7 days. [decision]
- S5. Files: for each module that stores files, how many and their total size; never a name, a ref or a hash. [decision]
- S6. Model: for each enabled module that declares `llm`, the settings that configure it and a "Test connection" button that asks the
  provider for its models and shows the endpoint, how long it took, how many models it lists and whether the module's model is among
  them, or the refusal with its code. The button works for administrators only, from the same origin only, and never shows the key. [decision]
- S7. Nothing on the screen changes data: no retry, cancel or delete, and no live refresh (reload the page). The only action is the
  model test, which is a read at the provider. [decision]
- S8. README (a section) and the HANDOFF say it exists and what it deliberately does not show.
- Not in this feature (follow-ups): retrying or cancelling a job from the screen; paging, filters or search; showing a payload; live
  updates; charts; a heartbeat table that would say for certain whether a worker is alive (the "is the worker running" line is an
  inference from jobs that are due and untouched).

## Tasks

- [x] T1 (S3, S5) the queries: job counts per module and status, dead and retrying jobs, how long the oldest due job has waited, file counts and sizes per module. Route: inline. Commit: next commit (RED observed; 58 tests)
- [x] T2 (S1, S3-S6) the status shaping in `apps/web/src/server/status.ts` (pure): wording, byte sizes, cut errors, the worker line. Route: inline. Commit: 96bbf7f (RED observed; 19 tests)
- [x] T3 (S1, S2, S6) the page, its tabs, the sidebar entry, the model test route and button. Route: inline. Commit: next commit (e2e 49/49 on a real build)
- [x] T4 (S8) end-to-end check on a real build, docs, full suite, independent verifier. Route: inline then verifier. Commit: next commit

## Log

- L1 (2026-10-21, user, verbatim): "sí, suma la pantalla de estado"
  (answering: "¿Querés además que sume una pantalla de estado en Settings (jobs en cola, últimos eventos, archivos guardados y un botón de probar el LLM), para que el trabajo hecho se vea?")
- L2: Route declaration: all tasks inline; no writer trigger. Mapping trigger fired once (explorer: shell layout and tabs, access control,
  the POST pattern and `authorizeWrite`, the services, the test conventions, the UI rules). Risk: security (item 2): the page reads
  the platform's internals for administrators only, `core.jobs.last_error` is the raw message of whatever a handler threw and may hold
  a secret, and the model test is an outbound call triggered from a browser. An independent verifier runs at the end.
- L3: Facts from the map. The proxy enforces only permissions that modules declare, so `/status` has a session check and nothing more:
  the page and the route must check `viewer.canWrite` themselves (Settings does the same). Shell sidebar entries are fixed in
  `sidebar-nav.tsx` and shown to everyone. There is no count-by-status method and no files total, so two small queries are new; the
  job `payload` is excluded by `list` unless asked for, and `last_error` is cut to 1000 characters when stored but not scrubbed.
- L4: Decisions taken without asking, per the standing instruction: show `last_error` (the screen is for the administrator, and the
  CLI shows it too) but cut to 200 characters, as text, and say on the tab that it is what the job reported; no payload, file name,
  ref or hash anywhere; the worker line is an inference and says so.
- L5: T3 observed. `/status` is a server component after Settings' pattern: it gates on `viewer.canWrite` before reading anything, reads the
  jobs, events and files services and the registry, and renders four tabs. The connection test is `POST /api/status/llm/<module>`,
  `authorizeWrite` first (session, administrator, same origin), then `runProbe` (pure, unit tested): 404 for a module that is not
  enabled or declares no `llm`, 422 not configured, 502 for a provider that refuses, 500 with nothing of the cause for the
  unexpected (the log gets it). `/status` is now a reserved shell path (a module that declared a page there would be refused by
  `pack`, `add` and the registry): a contract change for module authors, recorded in the README. Real build, end to end (49/49): a
  visitor is redirected, a non-administrator is told no and nothing is read, the administrator sees the dead job with its error
  cut to 200 characters, the events, the files total and the model test, and the page never contains the job's payload, a file's
  name, a ref, the file's content or the key; the test route refuses a visitor (401), a non-administrator (403), another site (403),
  a request with no origin (403), an unknown module (404), a refusing provider (502, key not in the answer) and an unset endpoint (422).
- L6: Independent verifier (it read the code and ran the small test files only, while the suite ran): S1-S8 pass, no blockers. Advisories
  fixed with tests that failed first: `formatBytes` wrote "1024 KB" for 1,048,575 bytes (now "1.0 MB"); `formatWait(NaN)` wrote "NaN d"
  (now "0 s"); the test button's accessible name did not contain its visible text (now "Test connection for <module>"). Left, not fixed:
  the model-test route has no rate limit or concurrency control, so a stolen administrator session can hold many 60 s outbound
  requests open (only against the endpoint the administrator configured); `counts()`, `totals()` and `troubled()` scan whole tables
  (`core.jobs` is pruned after 14 days and `core.events` after 7, so they stay small; files are not pruned).
- L7: The first full-suite run had one failure, in the INSTALL end-to-end file (not in this feature): the continuous probe counted one
  request as failed while the machine was building and running the whole suite. The probe waited 3 s per request; it now waits 15 s
  and the assertion says what each failed request got (a build that has gone fails at once with an error or a 5xx, so the probe still
  sees it). Reproduced under load: four processes burning the four cores, the test passes. Fixed on the install branch (9e6f962), which
  this branch is rebased on.
