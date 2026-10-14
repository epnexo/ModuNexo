# Enable, disable and uninstall from the Apps screen (stage A4d)

Objective: an administrator enables, disables or uninstalls an installed module from the Apps screen. The web
build embeds only enabled modules, so each of these changes the build: they run through a rebuild pipeline with
the same guarantees as install (build first, undo on failure, restart, audit).
Branch `feat/apps-lifecycle`, stacked on `feat/apps-screen` (head `b2bdaaf`). Delivery strategy `auto-chain`;
chain strategy not chosen (no remote). Test runner: `npm test`, `npm run typecheck`. Strict test-first.

## Specs

Quoted fragments are the owner's words; the rest is the plan agreed in the session, assumptions marked.

- **S1 Actions.** "enable/disable/uninstall" from the screen, administrator-only. The lifecycle's own rules decide
  whether an action is allowed (dependents, state); a refusal is shown with its reason and changes nothing.
- **S2 Order.** Assumption (same safe order as install): the registry for the state after the action is built into
  the web app first, then the lifecycle runs, then the server restarts. A build that fails touches nothing in the
  database; a lifecycle that fails restores the previous build and registration.
- **S3 Uninstall mode.** Uninstall asks for `keep` (the module's schema and data stay) or `purge` (schema and
  migration history are dropped). Purge needs an explicit extra confirmation on the screen; there is no default.
- **S4 Audit.** Every change is a row in `core.module_operations` (kind enable, disable or uninstall), with the
  actor, like installs; the same one-run-at-a-time lock covers installs and changes.
- **S5 Same command line.** `modules enable|disable|uninstall <id> --rebuild` runs the pipeline from the CLI (the
  existing commands without `--rebuild` stay as they are: they change the database only and print the reminder).
  The screen starts that command detached, like `apply`.
- **S6 Crash safety.** The journal and recovery of A4b cover a change: a run killed mid-way is put back, or kept
  if its database step had completed.
- **S7 Documentation.** The README describes it.

## Tasks

- [x] **T1** (S4) Migration `0008`: operation kinds enable/disable/uninstall, `sha256` nullable; the store.
  Route: inline.
- [x] **T2** (S1, S2, S3, S6) `changeModule`: preflight, build first, lifecycle, undo, restart, journal and
  recovery. Route: inline. Risk: item 1 (can purge a module's data) and item 5.
- [x] **T3** (S5) CLI `--rebuild` on enable/disable/uninstall, and the detached launch. Route: inline.
- [x] **T4** (S1, S3) API `POST /api/apps/modules/<id>` and the screen's controls. Route: inline. Risk: item 1.
- [x] **T5** End to end with a real build. Route: inline.
- [ ] **T6** (S7) README, independent verifier, native review. Route: inline plus verifier.

Forecast: about 900 authored changed lines; one slice per task.

## Log

- **L1** (2026-10-14, owner, verbatim): "me refiero que no veo movimiento en este projecto pense que se quedo
  bloqueado". Context: the owner saw no activity after A4c was reported and the session stopped to report; the
  standing instruction is to continue, so the next feature, announced at the end of A4c, starts now.
- **L2** Decisions taken without asking: the three actions share one pipeline ("change") because all of them
  change the set of enabled modules the build embeds; the existing CLI commands keep their behavior and the
  rebuild is opt-in with `--rebuild`, so nothing that already works changes; purge needs its own confirmation.
- **L3** (2026-10-14) Commits: T1 `3faf69c`, T2 `83c88bc`, T3 `1f534f7`,
  T4 `c77cfd2`, T5 `32f49c2`. Found while running the whole suite: builds failed
  under load with errors about files that exist (`TS6053`, `ENOENT _clientMiddlewareManifest.js`). Cause: the
  build cache linked between the kept `.next` and the new one (A4b design) is written in place. Every build now
  starts from an empty `.next` (`e04c9fc`); the full suite went from failing in 4 of 5 runs to 864/864.
  Also: a restart request that arrives during a restart is kept (the supervisor restarts once more), and a failed
  build's last lines are kept in the run's detail, so the Apps history says why.
