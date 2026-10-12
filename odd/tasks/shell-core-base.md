# Shell core base (stage A1)

Feature document for the first slice of the new epnexo platform shell. This file is the
source of truth; the Engram mirror lives under topic `odd/shell-core-base/tasks`.

## Objective

Build the base of a professional module platform core in an empty repository: a versioned
module contract with an SDK, a module lifecycle (install, enable, disable, upgrade,
uninstall), per-module SQL migrations, and generated registration, all working with zero
modules installed.

## Problem

The previous platform (repository `ai-usage-dashboard`) has a working core but no module
lifecycle. A module is hard-wired by name in about twelve places, "install" is one CLI
command that migrates every module at once, nothing can be disabled or uninstalled, and the
web shell already contains module-specific code (`moduleId === "marketing"` in the sidebar).

## Why

The owner wants modules that live in their own repositories and are installed, disabled and
uninstalled from the UI, with a restart allowed. That needs a contract and a lifecycle that
do not depend on any particular module, proven first with no modules at all. Existing
modules are adapted and installed one at a time afterwards, as the test of this core.

## Scope

In scope for this feature (A1):

- Repository scaffold: npm workspaces, strict TypeScript, test runner, typecheck, local
  Postgres 16.
- `@epnexo/sdk`: module manifest v2 types, `defineModule`, validation.
- `@epnexo/core`: registry with dependency resolution, migration runner, lifecycle state
  and service, registration codegen, CLI.

Out of scope here, planned as later features:

- A2 shell UI and admin login. A3 settings service and appearance. A4 Apps screen and the
  install pipeline (package upload, build, restart).
- Stage B: adapting `ai-usage`, `documents` and `marketing`. Stage C: scaffold command,
  packaging command, guide and creation skill.

## Constraints

- Stack stays TypeScript, Next.js and React (owner decision, 2026-10-12). Runtime loading of
  module code is not attempted: Next.js resolves client components and server actions
  against build-time manifests. Installing a module is package intake, build, restart.
- One central Postgres 16 database, one schema per module, plain ordered SQL migrations
  owned by each module.
- Environment variables only for infrastructure. This feature reads `DATABASE_URL` and
  `TEST_DATABASE_URL` and nothing else.
- Core never imports a module by name. Modules never import each other's code.
- Technical artifacts are written in English.

## Decisions

- **Port, do not rewrite.** `manifest.ts`, `registry.ts`, `migrations.ts`, `runner.ts`,
  `discovery.ts`, `pool.ts` and `testing.ts` from `ai-usage-dashboard/packages/core/src` are
  the starting point, with their tests. Known follow-ups from that code are fixed during
  the port: bounded advisory-lock wait, migration errors that name module and file, an idle
  error listener on the pool.
- **Two packages.** `@epnexo/sdk` is what a module compiles against (types, `defineModule`,
  validation, no database access). `@epnexo/core` is the platform (registry, migrations,
  lifecycle, codegen, CLI) and depends on the SDK.
- **Modules directory.** Installed module packages are unpacked under `modules/<id>/` and
  linked by the workspace glob. The directory is not tracked in git.
- **Manifest v2** adds to v1 (`id`, `version`, `name`, `schema`, `migrationsDir`, `nav`):
  - `platform`: semver range of the SDK the module supports.
  - `dependsOn`: map of module id to semver range (v1 was a list of ids).
  - `nav` entries gain `group`, `order` and `permission`.
  - `pages`: declared routes (`path`, `entry`, `kind: "page" | "route"`), consumed by the
    codegen so route files are generated, not hand-written.
  - `settings`: declared settings (`key`, `label`, `type`, `default`, `required`,
    `options`, `description`); `type` includes `secret`.
  - `permissions`: declared permission keys with labels.
  - `hooks`: optional entry exporting `onInstall`, `onEnable`, `onDisable`, `onUpgrade`,
    `onUninstall`.
- **Lifecycle states**: `available` (package present, not installed), `enabled`,
  `disabled`. An upgrade is pending when the package version is newer than the installed
  version.
  - install: `available` to `enabled`; runs migrations, `onInstall`, `onEnable`; requires
    every dependency enabled and the `platform` range satisfied.
  - disable: `enabled` to `disabled`; keeps data; blocked while an enabled module depends
    on it.
  - enable: `disabled` to `enabled`; requires dependencies enabled.
  - upgrade: applies pending migrations, runs `onUpgrade`, records the new version.
  - uninstall: to `available`; blocked while an installed module depends on it; the caller
    must choose `keep` (schema and migration history stay) or `purge` (schema dropped,
    migration history removed). There is no default.
- **Audit.** Every lifecycle transition is recorded in `core.module_events` (module,
  action, from, to, version, outcome, time).
- **Registration codegen** reads the manifests of enabled modules and writes one registry
  file plus thin route files for the web app. With zero modules it writes an empty
  registry. Generated files carry a header and are not edited by hand.

## Tooling

- Test runner: Node built-in `node:test` through `tsx`. Command:
  `node --env-file-if-exists=.env --import tsx --test "packages/*/test/**/*.test.ts"`
  (wired as `npm test` by T1).
- Typecheck: `npm run typecheck` (`tsc --noEmit -p tsconfig.json`).
- Integration tests use a database whose name ends in `_test`; an unreachable database is
  a skip, not a failure.
- TDD mode: strict (source: owner's global configuration). RED observed before
  implementation, then GREEN, then REFACTOR.

## Tasks

Route per task: delegated writer (trigger: two or more non-trivial files, and reading the
previous repository to prepare the write).

- [x] **T1** Repository scaffold and `@epnexo/sdk` manifest v2 (types, `defineModule`,
  validation) with tests.
- [x] **T1b** Harden manifest validation from the T1 review: normalised `pages[].path`
  (no `..`, whitespace, query, fragment or doubled slashes; duplicates compared after
  normalising a trailing slash), a test proving `..` is rejected inside `entry` and
  `hooks`, finite `number` defaults, `engines.node` declared, and the version contract
  pinned by tests (prerelease accepted, build metadata rejected).
- [x] **T2** `@epnexo/core` registry: dependency ordering with semver ranges, `platform`
  compatibility check, dependents lookup.
- [x] **T2b** Registry follow-ups from the T2 review: one locale-independent id comparator
  everywhere with a dependents-order test; a test pinning that a prerelease dependency
  does not satisfy an ordinary range (semver default, kept on purpose); `allowCoreSchema`
  bound to the id `core`; manifests frozen on admission.
- [x] **T3** Migration runner port: per-module schema, checksums, history guards, bounded
  lock, named errors, and `purge` of a module schema.
- [x] **T3b** Migration follow-ups from the T3 review: hermetic `db:migrate` test (own
  modules directory, no ambient modules); the `MODULES_DIR` test asserts the resolved path
  only; a dangling symlink in the modules directory is skipped with a named warning, not
  a raw `ENOENT`; the plan is validated before the module schema is created; a failed run
  reports what was applied before the failure; unit cases for purge without a history
  table and for the connection-terminated branch.
- [x] **T4** Lifecycle state: `core.modules` with state, `core.module_events`, and the
  transition rules as a pure function.
- [x] **T5** Lifecycle service: install, enable, disable, upgrade, uninstall (keep or
  purge), with hooks and dependency checks, against Postgres.
- [x] **T5b** Lifecycle follow-ups from the T5 review: install and enable also require each
  dependency's INSTALLED version to satisfy the declared range; uninstall with purge
  removes the schema, the history and the `core.modules` row atomically, with tests that
  fail at the purge and record steps; the rules are evaluated before any core migration
  runs and each step is labelled correctly; a malformed stored version flags that row
  instead of failing `list()`; an explicit `--modules-dir` that does not exist is an error.
- [x] **T6** Registration codegen: registry file and route files from enabled modules,
  empty output with zero modules.
- [x] **T7** CLI: `modules list | install | enable | disable | upgrade | uninstall`,
  `db:migrate`, `registry:generate`; README for the core.
- [ ] **T7b** Follow-ups from the T7 review and one design correction:
  - codegen: conflicting dynamic segment names at the same position are caught for
    prefixes, not only for whole paths; a run that fails partway cannot leave untracked
    generated files (ownership is recorded before deletion and recovered on the next run);
    unbalanced dynamic segment brackets are rejected.
  - lifecycle: a test pins that an installed prerelease dependency does not satisfy an
    ordinary range, matching the registry rule.
  - `db:migrate` migrates the core and INSTALLED modules only. Migrating a module that was
    never installed bypassed the lifecycle's dependency and platform checks and made it
    look like retained data; installing is what applies a module's first migrations.

## Acceptance criteria

- With no modules present, `npm test` and `npm run typecheck` pass, `db:migrate` creates
  only the `core` schema, and `registry:generate` writes an empty registry.
- A fixture module can be installed, disabled, enabled, upgraded and uninstalled through
  the CLI, and each transition appears in `core.module_events`.
- Uninstall with `keep` leaves the module schema; with `purge` the schema and its migration
  history are gone; without a choice the command refuses.
- Disabling or uninstalling a module that another enabled module depends on is refused with
  a message naming the dependent.
- A module whose `platform` range does not match the SDK version is refused at install.
- No file in `packages/` names a specific business module.

## Applicable checks

- `npm test` and `npm run typecheck` after every task.
- `gentle-ai review assess --base-ref <last reviewed boundary> --committed-only --json`
  after every work-unit commit (receipt-driven development is on by default).

## Delivery

- Strategy: `auto-chain` (owner's choice, 2026-10-12).
- Forecast: about 2,500 authored changed lines across T1 to T7, above the 400-line review
  budget, so the feature is delivered as a chain, one slice per task.
- Chain strategy: not chosen yet. The repository has no remote, so no pull request can be
  opened; the choice is asked when a remote exists.
- Branch: `feat/shell-core-base`, from an empty initial commit on `main`.

## Working agreement

The owner asked on 2026-10-13 to continue tasks and reviews automatically and to stop only
for a large decision. Review consent for each work unit is granted under that instruction.

## Progress

### T1 — done (2026-10-13)

- Commits: `5569421` scaffold, `0581b7c` SDK manifest v2, `27c9271` ignore `.atl/`.
- Checks observed by the orchestrator: `npm test` 27 pass, 0 fail; `npm run typecheck`
  clean. RED was reported by the writer for each behaviour group before implementation.
- Size: 666 authored lines excluding the lockfile and this document, above the 400-line
  heuristic; the validator and its 27 tests account for it and nothing was trimmed.
- Defaults the writer chose where this document was silent, accepted: `platform` and
  `dependsOn` required, other v2 sections optional; setting `options` are strings and a
  `select` default must be one of them; setting and permission keys are lowercase dotted
  identifiers; `core` is a reserved schema name.
- Review: assessed `medium` (`slice_budget_reached`), consent granted, lens
  `review-reliability`, outcome approved and acknowledged (lineage
  `review-cc2eb8dab6d3d8bc`). Reviewed boundary: `27c9271`.
- Advisory findings, none blocking: four warnings and the version-contract suggestion
  became T1b. Two suggestions are carried forward: provision the `_test` database in
  compose so integration tests cannot skip silently (with T3), and include `.tsx` in the
  typecheck once UI files exist (with the shell UI feature).

### T1b and T2 — done (2026-10-13)

- Commits: `b43cf35` manifest hardening, `e592888` registry, `2ef0ddd` neutral fixture
  names (the acceptance criterion "no file in `packages/` names a business module" was
  broken by T1 fixtures; fixed inline by the orchestrator).
- Checks observed by the orchestrator: `npm test` 61 pass, 0 fail; `npm run typecheck`
  clean. RED reported by the writer per behaviour group; the `..`-in-entry and
  prerelease/build-metadata cases were already true in behaviour, so their tests only pin
  it.
- Decisions taken where this document was silent: `engines.node` is `>=22.9.0` (first
  release with `--env-file-if-exists`); dependency and `platform` ranges follow semver's
  default prerelease rule; `dependentsOf` an unknown id returns an empty list; the core
  manifest is admitted through `Registry.registerCore()` and a validator option scoped to
  the `core` schema.
- Size: T2 is 462 authored lines, 251 of them tests.
- Review: `medium` (`slice_budget_reached`), consent granted under the working agreement,
  lens `review-reliability`, approved and acknowledged (lineage
  `review-35b6d4ba54a24fd0`). Reviewed boundary: `2ef0ddd`.
- Advisory findings, none blocking: two warnings and two suggestions, all taken as T2b.

### T2b and T3 — done (2026-10-13)

- Commits: `d8d9356` registry follow-ups, `6fb64c9` migration planner and runner,
  `bee545b` fixture rename, `ca3c85f` purge, discovery and `db:migrate`.
- Checks observed by the orchestrator with `TEST_DATABASE_URL` exported: `npm test` 139
  pass, 0 fail, 0 skipped; `npm run typecheck` clean. For new files the writer's RED was
  a missing module, so individual assertions were first exercised at GREEN.
- Database: compose project `epnexo-shell-core`, container `epnexo-db` on 127.0.0.1:5436.
  The test database is created on demand; an unreachable server is a visible skip, a
  reachable server that refuses is a failure.
- Pending for the owner: the local `.env` could not be created (a permission rule denies
  writing `.env*` files to the agent). Until it exists, a bare `npm test` skips the 21
  integration tests; agents export the two URLs inline.
- Decisions taken where this document was silent: the core migration creates only
  `core.schema_migrations` (lifecycle tables belong to T4); `migrateModule` brings the
  core up to date first and does not check dependencies; database names used by the test
  helper are lowercase letters, digits and underscores.
- Size: `6fb64c9` is 1,023 authored lines, about 600 of them tests; not split.
- Review: `medium` (`slice_budget_reached`), consent granted under the working agreement,
  lens `review-reliability`, approved and acknowledged (lineage
  `review-d493631001bfee03`). Reviewed boundary: `ca3c85f`.
- Advisory findings, none blocking: three warnings and three suggestions, taken as T3b.

### T3b, T4 and T5 — done (2026-10-13)

- Commits: `6cc1f80` migration hardening, `e1a817b` lifecycle state and pure transition
  rules, `a9bfc72` lifecycle service.
- Checks observed by the orchestrator with `TEST_DATABASE_URL` exported: `npm test` 227
  pass, 0 fail, 0 skipped; `npm run typecheck` clean. RED was an assertion failure or a
  throwing stub for the new behaviour; three cases only pin behaviour that already held.
- Failure semantics: rules first (a refusal changes and audits nothing); steps in order;
  the row and the `ok` event are written together after the last step; a failing step
  leaves `core.modules` unchanged, appends a `failed` event and throws naming module,
  action and step. Committed migrations stay applied and hooks are not undone, so hooks
  must be idempotent and a retry works.
- Locking: every action holds the migration advisory lock on one connection for its whole
  duration; `migrateModuleLocked` and `purgeModuleLocked` run on that connection. A hook
  must not call the lifecycle or `migrate`.
- Decisions taken where this document was silent: the registry can admit a module with an
  unsupported `platform` when asked (`allowUnsupportedPlatform`) so the refusal happens at
  install; upgrade to the same version is a no-op with no event; upgrade also checks
  `platform`; `discoverModules` returns `{ modules, warnings }`; `db:migrate` takes
  `--modules-dir`; `list()` does not include `core`; the audit table is append-only by
  convention, without a trigger; hook types live in core, not in the SDK.
- Open product question, not blocking: a row in `core.modules` whose package is gone is
  listed as `orphaned` and every action on it is refused. A cleanup path for orphans is
  not designed.
- Size: T4 821 and T5 980 authored lines, more than half of each tests; not split.
- Review: `medium` (`slice_budget_reached`), consent granted under the working agreement,
  lens `review-reliability`, approved and acknowledged (lineage
  `review-b1e7853884e4f1de`). Reviewed boundary: `a9bfc72`.
- Advisory findings, none blocking: two warnings and three suggestions, taken as T5b.

### T5b, T6 and T7 — done (2026-10-13)

- Commits: `502d3fb` lifecycle hardening, `5ab7812` registration codegen, `586634c` CLI
  and README.
- Checks observed by the orchestrator with `TEST_DATABASE_URL` exported: `npm test` 306
  pass, 0 fail, 0 skipped; `npm run typecheck` clean; no file under `packages/` names a
  business module. The writer ran `db:migrate`, `modules list` and
  `registry:generate --dry-run` by hand against the dev database with no modules.
- Acceptance criteria: each one is proven end to end by a spawned-CLI test in
  `packages/core/test/cli.test.ts` (journey, keep/purge/no-flag, dependents, platform
  mismatch, empty registry).
- Codegen: under the output root (default `apps/web`) it writes
  `src/generated/modules.ts` (modules in dependency order, flattened navigation, package
  names), one `page.tsx` or `route.ts` per declared page, and
  `src/generated/.manifest.json`. A file is owned when it starts with the generated
  header; a hand-written file in the way is an error found before any write.
- Additions to the manifest contract: optional `dynamic` on a page and optional `methods`
  on a route (segment config cannot be re-exported, and the generator cannot know which
  handlers an entry exports).
- What a module package needs: a `name`, `manifest.ts` at its root, no `exports` map
  hiding its files; page entries export `default` and `metadata`.
- Reserved shell paths: `/`, `/apps`, `/settings`, `/login`, `/logout`, `/api`, `/_next`.
- CLI exit codes: 0 done, 1 unexpected error or failed action, 2 usage error, 3 refusal.
- Size: T6 1,015 and T7 930 authored lines (tests and README are about half); not split.
- Review: `medium` (`slice_budget_reached`), consent granted under the working agreement,
  lens `review-reliability`, approved and acknowledged (lineage
  `review-cc793818a025e075`). Reviewed boundary: `586634c`.
- Advisory findings, none blocking: two warnings and two suggestions, taken as T7b.

## Next step

T7b, then close this feature. The next feature (A2, shell UI and admin login) needs the
owner's decisions before it starts.
