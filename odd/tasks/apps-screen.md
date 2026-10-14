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

- [ ] **T1** (S2, S5) `launchApply`: detached start of `modules apply`, log file, busy refusal; `--actor` option on
  the CLI command. Route: inline. Risk: item 5 (starts a process).
- [ ] **T2** (S1, S5) `receiveUpload`: stream to `var/`, size cap, intake. Route: inline. Risk: item 2 (untrusted input).
- [ ] **T3** (S1-S4) API: `POST /api/apps/packages`, `POST /api/apps/operations`, `GET /api/apps`; admin-only
  logic in a testable module. Route: inline. Risk: item 2.
- [ ] **T4** (S3, S4, S6) The Apps screen: modules, add-a-package flow, review, confirm, progress, history.
  Route: inline.
- [ ] **T5** (S1-S3) End to end over HTTP with a real build. Route: inline.
- [ ] **T6** (S7) README, independent verifier, native review. Route: inline plus verifier.

Forecast: about 1,200 authored changed lines; one slice per task.

## Log

- **L1** (2026-10-14, owner, verbatim): "si lanza apply". Context: answer to the closing question of A4b, which
  said the next step is the Apps screen "lanzando `apply` como proceso hijo"; read as yes, go on with A4c.
- **L2** Decisions taken without asking: A4c is split; enable/disable/uninstall from the screen become their own
  feature because the web build embeds only enabled modules, so they need place-less rebuild runs, which A4b
  does not have. The upload is a raw `application/gzip` body, not multipart, to keep the size cap simple and
  streaming; the launch is a detached CLI process because `apply` restarts the very server that handled the
  request.
