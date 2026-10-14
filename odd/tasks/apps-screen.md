# Apps screen: upload, review, install, progress (stage A4c)

Objective: an administrator adds a module package from the Apps screen: uploads the archive, reads the review,
confirms, and watches the install run, with the history of every run. It uses what A4a (intake) and A4b (apply)
already do; the screen starts them and shows them.
Branch `feat/apps-screen`, stacked on `feat/module-install` (head `33f8155`). Delivery strategy `auto-chain`;
chain strategy not chosen (no remote). Test runner: `npm test`, `npm run typecheck`. Strict test-first.

## Specs

Quoted fragments are the owner's words; the rest is the plan agreed in the session, assumptions marked.

- **S1 Upload.** "package upload with checksum": an administrator sends the archive (raw body, at most the
  intake's 50 MB, read as a stream and refused as soon as it goes over) and may give the SHA-256 the publisher
  gave. The reply is the same review `modules add` prints, or every problem when it is refused.
- **S2 Confirm.** "admin only": nothing is installed by the upload. Installing is a second, explicit request that
  names the package by its SHA-256; it starts `modules apply` as a detached process (so it survives the server
  restart it causes) and answers at once with 202. A second request while a run is alive is refused with 409.
- **S3 Progress and audit.** The screen shows the run in progress (step, detail) by polling, and the history of
  runs and of received packages (accepted and refused, with problems), from `core.module_operations` and
  `core.module_packages`.
- **S4 Who.** Every write is administrator-only and same-origin, like the settings API; reading the run list is
  administrator-only too. The actor recorded is the signed-in user, not "cli". A non-administrator sees the list
  of modules and no controls.
- **S5 Safe by construction.** Assumptions: the apply child is started with a fixed command and the SHA-256 as its
  only argument (validated as 64 hex characters), never through a shell; its output goes to a log file under
  `var/logs/`; the upload is written under `var/` only, never to a path the client chose.
- **S6 Not here.** Enable, disable and uninstall from the screen are the next feature: they need a rebuild
  pipeline of their own. The page keeps pointing to the CLI for them.
- **S7 Documentation.** The README describes the screen and its API.

## Tasks

- [x] **T1** (S2, S5) `launchApply`: detached start of `modules apply`, log file, busy refusal; `--actor` option on
  the CLI command. Route: inline. Risk: item 5 (starts a process).
- [x] **T2** (S1, S5) `receiveUpload`: stream to `var/`, size cap, intake. Route: inline. Risk: item 2 (untrusted input).
- [x] **T3** (S1-S4) API: `POST /api/apps/packages`, `POST /api/apps/operations`, `GET /api/apps`; admin-only
  logic in a testable module. Route: inline. Risk: item 2.
- [x] **T4** (S3, S4, S6) The Apps screen: modules, add-a-package flow, review, confirm, progress, history.
  Route: inline.
- [x] **T5** (S1-S3) End to end over HTTP with a real build. Route: inline.
- [x] **T6** (S7) README, independent verifier, native review. Route: inline plus verifier.

Forecast: about 1,200 authored changed lines; one slice per task.

## Log

- **L1** (2026-10-14, owner, verbatim): "si lanza apply". Context: answer to the closing question of A4b, which
  said the next step is the Apps screen "lanzando `apply` como proceso hijo"; read as yes, go on with A4c.
- **L2** Decisions taken without asking: A4c is split; enable/disable/uninstall from the screen become their own
  feature because the web build embeds only enabled modules, so they need place-less rebuild runs, which A4b
  does not have. The upload is a raw `application/gzip` body, not multipart, to keep the size cap simple and
  streaming; the launch is a detached CLI process because `apply` restarts the very server that handled the
  request.
- **L3** (2026-10-14) Found while wiring T5: importing `@epnexo/core/install` into the web bundle pulled
  `install/build.ts` (it resolves `next` at run time), and the web build failed in Turbopack's tracing. The web
  app now imports the core through a narrow entry, `@epnexo/core/apps`, that holds only what the screen uses.
  Also found: two settings test files swept each other's rows with `like 't-%'` in the shared test database
  (pre-existing, surfaced as flakes); each now deletes only its own ids.
- **L4** (2026-10-14) Independent verifier (sonnet, scratch DB, real e2e run once): S1-S6 met, S3 and S7 partly,
  two blockers. B1: after Confirm the screen did not poll (the run row appears about a second later) and an
  apply refused before it records a run was invisible; fixed: the page watches for a minute after Confirm, and
  `launchApply` waits up to 4 s to see whether the process ends at once and the API answers 422 with what it
  printed. B2: a 300 KB gzip of zeros pinned the server CPU for minutes because the tar parser is not linear in
  trailing zeros; fixed in `inspectArchive`: after the end-of-archive marker what follows is counted and dropped
  (a 64 MB zero bomb now takes milliseconds; a file whose body is zeros is still counted). Advisories fixed: SHA-256
  in upper case is accepted like on the command line, stale `running` rows are closed when the screen lists runs,
  README. Left: a failed first start (bad entry path) is visible only in the log. Suite 833 pass, 0 fail.
  Commit `15801db`.
- **L5** (2026-10-14) Native review of `33f8155..HEAD` (risk, resilience, reliability): approved and acknowledged,
  five warnings. Three of them were one real problem in the B2 fix: stopping at "4096 zeros outside a file body"
  could drop entries that the extractor would write (a zero-filled file ending on a chunk boundary), so they
  would not have been inspected. Replaced by the parser's own `eof` event (it ignores what follows the
  end-of-archive marker, and so does `extract`; checked with a concatenated archive), with tests for zero-filled
  files of many sizes followed by a symlink and for entries after the marker. Also fixed: a process that cannot
  be started reports why. Not changed: the cap on a chunked upload is proved at unit level only, and an
  immediate exit 0 inside the settle window counts as started. Suite 836 pass, 0 fail.
