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
- [ ] **T3** (S3, S4) Build step with rollback of `.next` and the generated registry; the build command is
  injectable. Route: inline. Risk: item 5.
- [ ] **T4** (S1, S3, S4, S6, S7) `applyPackage`: the pipeline end to end with undo, against a scratch DB and a
  fake build. Route: inline. Risk: items 1 and 5.
- [ ] **T5** (S1, S5) CLI `modules apply`, the restart contract (server exit code + pid file + `web:start`
  supervision). Route: inline. Risk: item 5.
- [ ] **T6** (S8) Real end-to-end with a fixture module and a real build, README, independent verifier, native
  reviews. Route: inline plus verifier.

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
