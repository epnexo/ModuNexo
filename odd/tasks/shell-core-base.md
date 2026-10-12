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
- [ ] **T2b** Registry follow-ups from the T2 review: one locale-independent id comparator
  everywhere with a dependents-order test; a test pinning that a prerelease dependency
  does not satisfy an ordinary range (semver default, kept on purpose); `allowCoreSchema`
  bound to the id `core`; manifests frozen on admission.
- [ ] **T3** Migration runner port: per-module schema, checksums, history guards, bounded
  lock, named errors, and `purge` of a module schema.
- [ ] **T4** Lifecycle state: `core.modules` with state, `core.module_events`, and the
  transition rules as a pure function.
- [ ] **T5** Lifecycle service: install, enable, disable, upgrade, uninstall (keep or
  purge), with hooks and dependency checks, against Postgres.
- [ ] **T6** Registration codegen: registry file and route files from enabled modules,
  empty output with zero modules.
- [ ] **T7** CLI: `modules list | install | enable | disable | upgrade | uninstall`,
  `db:migrate`, `registry:generate`; README for the core.

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

## Next step

T2b, then T3.
