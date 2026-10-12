# epnexo platform

A module platform: a small core that installs, enables, disables, upgrades and uninstalls
modules, each living in its own repository. This repository holds the core and the SDK that
modules compile against. The feature plan lives in `odd/tasks/`.

## Layout

- `packages/sdk` - `@epnexo/sdk`: module manifest v2 types, `defineModule`, `validateManifest`.
  No database access.
- `packages/core` - `@epnexo/core`: the platform core. Today it holds the module `Registry`
  (manifest validation, `platform` and `dependsOn` range checks, dependency order, dependents
  lookup), the core's own manifest and the migration runner; the lifecycle and CLI follow.
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
npm run db:migrate -- --modules-dir /path/to/dir    # discover modules somewhere else
```

`db:migrate` prints discovery warnings to stderr and, when a run fails, the files applied before the failure.

A pool built with `createPool` logs errors from idle clients instead of crashing the process.
