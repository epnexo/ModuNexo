# Module install pipeline (stage A4b)

Objective: turn a staged package (A4a) into a running module: place it, build the web app with it, install it
through the lifecycle, restart, and undo everything if a step fails. Every run is recorded. The Apps screen
(A4c) will only start and show this; the command line does it first.
Branch `feat/module-install`, stacked on `feat/module-intake` (head `e02777e`). Delivery strategy `auto-chain`;
chain strategy not chosen (no remote). Test runner: `npm test`, `npm run typecheck`. Strict test-first.

## Specs

Quoted fragments are the owner's words; the rest is the plan agreed in the session, assumptions marked.

- **S1 What it is.** "package upload with checksum, automated build, restart, rollback, audit, admin only" and
  "install plus restart is fine". `epnexo modules apply <sha256>` takes a package staged by `modules add` and
  installs it (or upgrades the installed module of the same id to its version).
- **S2 Placement.** The staged tree is copied to `modules/<id>/` (folder = module id, never over an existing
  folder for an install), and `node_modules/<package name>` is made a relative symlink to it, which is what
  `npm install` does for a workspace. No npm command runs and nothing is installed from a registry. An upgrade
  keeps the previous folder under `var/previous/<id>-<version>/` until the run succeeds.
- **S3 Build first, then the database.** Assumption (safe order): the web app is built with the module included
  before its migrations run, so a build that fails leaves the database untouched. The registry is generated
  with the module forced in, `next build` runs, then the lifecycle installs/upgrades (migrations, hooks).
- **S4 Rollback.** Any failed step restores what the run changed: the previous `.next`, the previous generated
  registry, the module folder and link (or the previous version's folder). A failure after the lifecycle
  already applied migrations cannot undo the database (the lifecycle's own rule); it says so and keeps the
  previous build serving. The run ends `failed` or `rolled_back` and is never left `running`.
- **S5 Restart.** Assumption: the platform has no supervisor today. The launcher gets one: the server asks to
  be restarted by exiting with a documented code, and `web:start` restarts it on that code and on no other. The
  pipeline asks by signalling the pid the running server recorded. If no server runs, nothing is signalled.
- **S6 Audit and progress.** Every run is a row in `core.module_operations` (module, version, package SHA-256,
  kind, status, current step, detail, actor, times), updated as it goes, so a screen can show progress.
  Only one run at a time (a lock); a second one is refused while one runs.
- **S7 Nothing new is trusted.** Placement reads files as data and applies only what intake already validated.
  The lifecycle's own rules still decide whether install or upgrade is allowed (dependsOn, platform, version).
- **S8 Documentation.** The README explains the command, the order, rollback, and the restart contract.

## Tasks

- [x] **T1** (S6) Migration `0007_module_operations.sql` and the operations store (start, step, finish, list,
  single-run lock). Route: inline. Commit `a3c5ac6`.
- [x] **T2** (S2, S4) Placement and undo: copy staged tree, link in `node_modules`, keep the previous version.
  Route: inline. Risk: item 1 (replaces files of an installed module). Commit `353a38f`.
- [x] **T3** (S3, S4) Build step with rollback of `.next` and the generated registry; the build command is
  injectable. Route: inline. Risk: item 5. Commit `dd5cfac`.
- [x] **T4** (S1, S3, S4, S6, S7) `applyPackage`: the pipeline end to end with undo, against a scratch DB and a
  fake build. Route: inline. Risk: items 1 and 5. Commit `72ab8c3`.
- [x] **T5** (S1, S5) CLI `modules apply`, the restart contract (server exit code + pid file + `web:start`
  supervision). Route: inline. Risk: item 5. Commit `09d1512`.
- [x] **T6** (S8) Real end-to-end with a fixture module and a real build, README, independent verifier, native
  reviews. Route: inline plus verifier. Commits `a5bc49a`, `d90da71`, `777521f`.

Forecast: about 1,500 authored changed lines; one slice per task.

## Log

- **L1** (2026-10-14, owner, verbatim): "continue". Context: after A4a closed, with A4b announced as next.
  The earlier agreed plan for A4 and "install plus restart is fine" hold.
- **L2** Decisions taken without asking, each with a safe default: A4b is the command-line pipeline and A4c the
  screen over it; build runs before migrations so a failed build never touches the database; no `npm install`
  (a symlink does what a workspace install does); the launcher gets a restart-on-exit-code supervisor because
  none exists; one run at a time. Mapping evidence: lifecycle holds the migration advisory lock and builds its
  registry from disk (so apply must discover after placement), codegen only includes enabled modules (so apply
  forces the module in for the build), `next build` runs `registry:generate` itself and needs the database.
- **L3** (2026-10-14) Design correction found while building T3: the first idea of keeping `.next` as hard links
  is unsafe (anything that writes in place changes the backup too), so the previous build is moved aside whole
  and only its `cache` folder is linked back. The pipeline calls `next build` itself after generating the
  registry with the new module forced in, because `web:build` runs `registry:generate` from the database,
  where the module is not enabled yet, and would drop it.
- **L4** (2026-10-14) Found while writing T4: intake validates `manifest.json`, but what the platform loads at
  install is `manifest.ts`, which is code, so a package could show one thing and run another. `apply` now loads
  the placed `manifest.ts` and refuses (and undoes) unless it equals the reviewed `manifest.json`. Also,
  `discoverModules` takes `freshImport` so a replaced package is not served from the module cache in an upgrade.
- **L5** (2026-10-14) T5 simplified the restart contract of S5: instead of a server exit code, the launcher
  (`apps/web/scripts/run.ts`, now a small supervisor in `apps/web/src/server/supervisor.ts`) records its pid in
  `var/run/web.pid` and restarts its child on SIGUSR2 only. The pipeline signals that pid after checking its
  command line is the launcher's, so a stale pid file can never make it signal another process. Dev mode is not
  supervised.
- **L6** (2026-10-14) Independent verifier (sonnet, scratch DB, real e2e run once): S1-S8 met except S4/S6 partly,
  one blocker: SIGINT during the build left `.next` partial, the good build in `.next.rollback`, the new
  folder in place and the run `running`, and a retry was refused. Fixed test first: the pipeline handles
  SIGINT/SIGTERM (aborts the build, rolls back), writes `var/run/apply.journal.json` before it changes anything,
  and the next apply recovers from it (undo, or keep when the database step had completed). Advisories also
  fixed: a disabled module is not forced into the build on upgrade, the restart check requires the command to be
  `run.ts start` (not build/dev), a server that ignores SIGTERM is killed after 15 s, and a kept
  `var/previous/<id>-<v>` no longer blocks a later upgrade. Left as is, noted: dependsOn/lifecycle rules refuse at
  the build step (cleanly undone, exit 1) rather than at preflight; `--json` refusals print plain text; empty
  directories can remain after a rollback. One full-suite run showed a single unreproducible failure in
  `cli-db-migrate` under load (passes alone and in two further full runs). Suite 798 pass, 0 fail.
- **L7** (2026-10-14) Native review of `e02777e..d90da71` (risk, resilience, reliability): approved and
  acknowledged, five warnings. Fixed test first or with tests: build rollback and placement undo are tried
  separately; the recovery branches (keep when the database step completed, undo in the lifecycle and placing
  phases, no-op while a run is alive) are covered; the e2e lock removes a stale lock by an atomic rename.
  Documented as limits: the pipeline is Linux-only (`cp -al`, `/proc`), and the linked build cache can be
  changed in place by a build (harmless: it is a cache). Final suite before this commit 798 pass, 0 fail; the
  real end-to-end run passes (3/3).
- **L8** (2026-10-14) Superseded by A4d, found there: linking the build cache between the kept `.next` and the new
  one (L3, L7) was wrong. Under a loaded full suite builds failed with errors about files that exist
  (`TS6053 File ... page.tsx not found`; `ENOENT _clientMiddlewareManifest.js` written moments before) and only
  when a cache was reused; Turbopack and TypeScript write the cache in place, so the kept build and the new one
  shared mutable state. The new build now starts from an empty `.next`; the previous one is moved aside whole.
