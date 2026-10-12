# epnexo platform

A module platform: a small core that installs, enables, disables, upgrades and uninstalls
modules, each living in its own repository. This repository holds the core and the SDK that
modules compile against. The feature plan lives in `odd/tasks/`.

## Layout

- `packages/sdk` - `@epnexo/sdk`: module manifest v2 types, `defineModule`, `validateManifest`.
  No database access.
- `packages/core` - `@epnexo/core`: the platform core. Today it holds the module `Registry`
  (manifest validation, `platform` and `dependsOn` range checks, dependency order, dependents
  lookup), the core's own manifest, the migration runner and the module lifecycle (rules, state tables and
  service); the CLI follows.
- `modules/` - installed module packages, one folder per module. Not tracked in git.
- `apps/` - applications built on the core.

Everything is TypeScript consumed from source; there is no build step for packages.

## Commands

```bash
npm install
npm test          # node:test through tsx, packages/*/test/**/*.test.ts
npm run typecheck # tsc --noEmit
```

## Database

Configuration is read from `.env` (copy `.env.example`): `DATABASE_URL` and `TEST_DATABASE_URL`.

```bash
docker compose up -d db   # Postgres 16 on 127.0.0.1:5436, compose project "epnexo-shell-core"
```

Integration tests run against a separate database whose name must end in `_test` (anything else is
refused, as is the development database). It is created on demand on the same server, so no extra
setup is needed. Two situations are kept apart:

- no database server answers, or neither URL is set: the integration tests are **skipped** with the
  reason printed;
- a server answers but the test database cannot be created or reached (bad credentials, missing
  permission): the suite **fails**.

With the database up, `npm test` reports 0 skipped.

## Migrations

Each module owns its schema and ships plain SQL files in `<moduleDir>/<migrationsDir>/NNNN_name.sql`
(the core's are in `packages/core/migrations`). `migrate` (all modules, in dependency order, core
first) and `migrateModule` (one module, after bringing the core up to date) in `@epnexo/core`:

- create the module schema when absent and run each file in its own transaction with `search_path` set
  to that schema; the history row is written in the same transaction, so a failing file leaves nothing
  behind;
- track history in `core.schema_migrations(module_id, filename, checksum, applied_at)`, created by the
  core's own first migration;
- refuse rewritten history: an applied file that is missing from disk, edited (checksum), or a new file
  numbered before the latest applied one; duplicate numbers are rejected;
- hold a Postgres advisory lock so concurrent runs serialise; the wait is bounded
  (`lockTimeoutMs`, default 30 s) and fails with a clear error instead of hanging;
- name the module and file in a failing migration's error and keep the database error as `cause`.

`purgeModule` drops a module's schema (cascade) and deletes its history rows in one transaction under the
same lock. It refuses the `core` module and any module the registry does not know, and schema names are
validated and quoted, never interpolated as given.

`discoverModules(MODULES_DIR)` loads `modules/<id>/manifest.ts` (default export, folder name equal to the
id) and returns `{ modules, warnings }`: validated manifests with `migrationsDir` resolved, plus a
message for every entry that was skipped (a symlink whose target is gone, for instance). An empty
`modules/` yields nothing.

The plan for each module (directory present, file names, duplicate numbers, history guards) is checked
before its schema is created, so a refused plan leaves nothing behind. A run that fails partway throws a
`MigrationRunError` whose `applied` lists the files already committed in that run.

```bash
npm run db:migrate                                  # the core plus every module under modules/
npm run db:migrate -- --modules-dir /path/to/dir    # discover modules somewhere else (the path must exist)
```

`db:migrate` prints discovery warnings to stderr and, when a run fails, the files applied before the failure.

A pool built with `createPool` logs errors from idle clients instead of crashing the process.

## Module lifecycle

A module is in one of three states. `available` means its package is on disk and nothing is installed (it
has no row in the database); `enabled` and `disabled` are the two installed states, stored in
`core.modules` (`id`, `state`, `installed_version`, `installed_at`, `updated_at`). Nothing the manifest
already says is stored.

| Action | From | To | What it does |
| --- | --- | --- | --- |
| `install` | available | enabled | runs the module's migrations, then `onInstall` and `onEnable`. Needs every dependency enabled, its INSTALLED version inside the declared range, and the `platform` range satisfied. |
| `enable` | disabled | enabled | runs `onEnable`. Needs every dependency enabled and at an installed version inside the declared range. |
| `disable` | enabled | disabled | runs `onDisable`; all data is kept. Refused while an enabled module depends on it, directly or not. |
| `upgrade` | enabled or disabled | same | applies pending migrations, runs `onUpgrade` (previous and new version), records the new version. Only to a higher package version: no downgrade; an equal version is a no-op. |
| `uninstall` | enabled or disabled | available | disables first if enabled, runs `onUninstall`, then removes the row. Refused while any installed module depends on it. |

`uninstall` needs an explicit mode and there is no default:

- `keep` leaves the module's schema and its migration history in place. The module is available again
  with `dataRetained` set, and installing it later finds its data.
- `purge` drops the schema (cascade) and deletes the module's migration history. The drop, the history
  deletion and the removal of the `core.modules` row commit together or not at all.

The `core` module can never be installed, enabled, disabled, upgraded or uninstalled. The rules are a pure
function (`planTransition`) that returns a plan or a coded refusal naming the blocking modules.
`LifecycleService` performs them against Postgres:

```ts
const lifecycle = new LifecycleService(pool, registry);   // registry: Registry with the core and the discovered modules
await lifecycle.install("some-module");
await lifecycle.uninstall("some-module", "keep");
await lifecycle.list();   // status, upgradePending, orphaned (row without a package), dataRetained
```

Hooks come from the manifest's `hooks` entry (a path relative to `modules/<id>/`; the loader is injectable).
Every export is optional and receives `{ moduleId, version, previousVersion?, mode?, db }`.

Every action is serialised with the migration advisory lock, so two actions never interleave. The rules are evaluated
before anything else, including the core's own migrations, so a refused action changes and creates nothing and is
not audited. A stored version that is not valid semver does not break `list()`: the row is flagged
(`invalidInstalledVersion`) and every action on it is refused with `invalid_installed_version`. If a migration or hook throws, `core.modules` is left as it was, a `failed`
event is recorded and the error names the module, the action and the step. Migration files already committed
stay applied and hooks that already ran are not undone, so retrying the action is the way forward (hooks should
be idempotent).

Every transition is appended to `core.module_events` (it has no foreign key, so it outlives an uninstall):

| Column | Meaning |
| --- | --- |
| `module_id`, `action` | the module and `install`, `enable`, `disable`, `upgrade` or `uninstall` |
| `from_state`, `to_state` | `available`, `enabled` or `disabled` |
| `version` | the version after the action (the installed one for enable, disable and uninstall) |
| `outcome` | `ok` or `failed` |
| `detail` | `keep` or `purge` for an uninstall; for a failure, `<step>: <error message>` |
| `occurred_at` | when it was recorded |
