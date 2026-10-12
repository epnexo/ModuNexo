# epnexo platform

A module platform: a small core that installs, enables, disables, upgrades and uninstalls modules, each living
in its own repository, and generates the registration the web app needs from the modules that are enabled. This
repository holds the SDK modules compile against and the core. The feature plan lives in `odd/tasks/`.

## Layout

| Path | What it is |
| --- | --- |
| `packages/sdk` | `@epnexo/sdk`: manifest v2 types, `defineModule`, `validateManifest`. No database access. |
| `packages/core` | `@epnexo/core`: the registry, migration runner, lifecycle, registration codegen and CLI. |
| `modules/` | Installed module packages, one folder per module, linked by the npm workspace glob. Not tracked in git. |
| `apps/` | Applications built on the core. Empty today; the web shell is a later feature. |
| `odd/tasks/` | Feature documents. |

Everything is TypeScript consumed from source; there is no build step for packages. The core never imports a
module by name, and modules never import each other's code.

## Setup

```bash
npm install
docker compose up -d db      # Postgres 16 on 127.0.0.1:5436, compose project "epnexo-shell-core"
cp .env.example .env         # DATABASE_URL and TEST_DATABASE_URL
echo "EPNEXO_MASTER_KEY=$(openssl rand -base64 48)" >> .env
npm run db:migrate           # creates the core schema
npm run epnexo -- admin create --email you@example.com --name "Your Name"   # asks for the password
npm test                     # node:test through tsx, packages/*/test/**/*.test.ts
npm run typecheck            # tsc --noEmit
```

The only environment variables are infrastructure ones:

- `DATABASE_URL` - the database the CLI works on.
- `TEST_DATABASE_URL` - the database integration tests run on. Its name must end in `_test` and it must not be
  the development database. It is created on demand on the same server.
- `EPNEXO_MASTER_KEY` - the one secret the platform reads from the environment, at least 32 characters
  (`openssl rand -base64 48`). The sign-in secret is derived from it, so there is no separate variable for it.
  Changing it signs every user out. Only the commands that touch authentication need it.

No server answering, or neither variable set, **skips** the integration tests with the reason printed; a server
that answers but refuses (bad credentials, missing permission) **fails** the suite. With the database up,
`npm test` reports 0 skipped.

## The module contract

A module is a package under `modules/<id>/` with a `manifest.ts` that default-exports its manifest:

```ts
import { defineModule } from "@epnexo/sdk";

export default defineModule({
  id: "sample",                       // kebab-case, equal to the folder name
  version: "1.2.0",                   // semver, prerelease allowed, no build metadata
  name: "Sample",
  platform: "^0.1.0",                 // range of SDK versions the module supports
  dependsOn: { other: "^1.0.0" },     // module id -> range; each must be enabled and installed in range
  schema: "sample",                   // the Postgres schema this module owns ("core", "public" are reserved)
  migrationsDir: "migrations",        // NNNN_name.sql files, relative to the module folder
  nav: [{ label: "Sample", href: "/sample", icon: "chart", group: "Tools", order: 10, permission: "sample.read" }],
  pages: [
    { path: "/sample", entry: "./web/page.tsx", kind: "page", dynamic: "force-dynamic" },
    { path: "/sample/export", entry: "./web/export.ts", kind: "route", methods: ["GET"] },
  ],
  settings: [{ key: "page_size", label: "Page size", type: "number", default: 50 }],
  permissions: [{ key: "sample.read", label: "Read samples" }],
  hooks: "./hooks.ts",                // optional: exports onInstall, onEnable, onDisable, onUpgrade, onUninstall
});
```

Required: `id`, `version`, `name`, `platform`, `dependsOn`, `schema`, `migrationsDir`, `nav`. The rest is optional.
`validateManifest` rejects unknown fields and lists every problem at once.

- `nav` entries carry `group`, `order` and the `permission` that must be held to see them.
- `pages` declare routes. Paths are absolute and normalised (no `..`, query, fragment or doubled slashes);
  `[id]`, `[...slug]` and `[[...slug]]` are allowed, with balanced brackets and nothing around them (`[id]]` is rejected). `kind: "page"` renders UI, `kind: "route"` is an HTTP
  handler and may list the `methods` it exports (default `["GET"]`). `dynamic` is the Next.js segment config
  (`auto`, `force-dynamic`, `force-static`, `error`), which Next.js only reads from the route file itself.
- `settings` have a `key`, `label`, `type` (`string`, `number`, `boolean`, `select`, `secret`, `path`),
  `default`, `required`, `options` (for `select`) and `description`. A `secret` cannot declare a default.
- `hooks` is a path to a file whose exports are called by the lifecycle (see below).

For the web app a module's `package.json` needs a `name` (the web app imports the module through it), must not
hide its files behind an `exports` map, and keeps `manifest.ts` at its root.

### Migrations

Each module owns its schema and ships plain SQL files in `<migrationsDir>/NNNN_name.sql`; the core's own are in
`packages/core/migrations`. `migrate` (every module in dependency order, core first) and `migrateModule` (one
module, after bringing the core up to date):

- create the module schema when absent and run each file in its own transaction with `search_path` set to that
  schema; the history row is written in the same transaction, so a failing file leaves nothing behind;
- track history in `core.schema_migrations(module_id, filename, checksum, applied_at)`;
- refuse rewritten history: an applied file that is missing from disk, edited (checksum), or a new file numbered
  before the latest applied one; duplicate numbers are rejected;
- hold a Postgres advisory lock so concurrent runs serialise; the wait is bounded (`lockTimeoutMs`, default
  30 s) and fails with a clear error instead of hanging;
- name the module and file in a failing migration's error and keep the database error as `cause`; a run that
  fails partway throws a `MigrationRunError` whose `applied` lists the files already committed.

The plan for a module (directory, file names, duplicate numbers, history guards) is checked before its schema is
created, so a refused plan leaves nothing behind. `discoverModules(dir)` loads `<dir>/<id>/manifest.ts` and
returns `{ modules, warnings }`; a symlink whose target is gone is skipped with a warning.

## Module lifecycle

A module is `available` (its package is on disk and nothing is installed; no row), `enabled` or `disabled` (rows
in `core.modules`: `id`, `state`, `installed_version`, `installed_at`, `updated_at`).

| Action | From | To | What it does |
| --- | --- | --- | --- |
| `install` | available | enabled | runs the module's migrations, then `onInstall` and `onEnable`. Needs every dependency enabled with its INSTALLED version inside the declared range, and the `platform` range satisfied. A prerelease only satisfies a range that names its own prerelease line: `1.0.0-rc.1` does not satisfy `^1.0.0` but does satisfy `^1.0.0-rc.0`. |
| `enable` | disabled | enabled | runs `onEnable`. Needs every dependency enabled and installed at a version inside the range. |
| `disable` | enabled | disabled | runs `onDisable`; all data is kept. Refused while an enabled module depends on it, directly or not. |
| `upgrade` | enabled or disabled | same | applies pending migrations, runs `onUpgrade`, records the new version. Only to a higher package version; an equal version is a no-op. |
| `uninstall` | enabled or disabled | available | disables first if enabled, runs `onUninstall`, then removes the row. Refused while any installed module depends on it. |

`uninstall` needs an explicit mode and there is no default: `keep` leaves the schema and its migration history
(installing again finds the data), `purge` drops the schema (cascade) and deletes the history. The drop, the
history deletion and the removal of the `core.modules` row commit together or not at all.

The `core` module can never be managed. The rules are a pure function, `planTransition`, which returns a plan or a
coded refusal naming the blocking modules; `LifecycleService` carries plans out against Postgres:

```ts
const lifecycle = new LifecycleService(pool, registry);  // registry: the core plus the discovered modules
await lifecycle.install("sample");
await lifecycle.uninstall("sample", "keep");
await lifecycle.list();  // status, upgradePending, orphaned, dataRetained, invalidInstalledVersion
```

### Failure semantics

- The rules are evaluated first, before anything else, including the core's own migrations. A refusal throws
  `LifecycleRefusedError` (with a `code` and the `related` module ids), changes and creates nothing, and is not
  audited. On a database that was never migrated the lifecycle tables do not exist yet; reading them then
  yields no rows, which is correct, and the core migrations run only once an action is accepted.
- Steps then run in order (install: migrations, `onInstall`, `onEnable`; enable: `onEnable`; disable:
  `onDisable`; upgrade: migrations, `onUpgrade`; uninstall: `onDisable` if enabled, `onUninstall`). The last step
  is one transaction: for `purge` the schema drop and history deletion, then the new row and the `ok` event.
- If a step throws, `core.modules` is left exactly as it was, a `failed` event is appended and a
  `LifecycleStepError` names module, action and step (`lock`, `read state`, `plan`, `core migrations`,
  `load hooks`, `migrations`, a hook name, `purge`, `record`) with the original error as `cause`.
- Effects of steps that already succeeded are not undone: migration files are committed one by one and hooks
  that ran have run. Retrying is the way forward, so hooks must be idempotent.
- Every action holds the migration advisory lock on one connection for its whole duration, so two actions (or an
  action and `migrate`) never interleave. A hook runs with the lock held and must not call the lifecycle or
  `migrate`.
- A stored version that is not valid semver does not break `list()`: the row is flagged
  (`invalidInstalledVersion`) and every action on it is refused with `invalid_installed_version`.
- A row whose package is gone is listed as `orphaned`; every action on it is refused.

Every transition is appended to `core.module_events` (no foreign key, so it outlives an uninstall): `module_id`,
`action`, `from_state`, `to_state`, `version`, `outcome` (`ok` or `failed`), `detail` (`keep` or `purge` for an
uninstall; `<step>: <message>` for a failure) and `occurred_at`.

## CLI

One entry, `packages/core/src/cli/index.ts`, wired as npm scripts (`npm run epnexo -- <command>` runs any command):

```bash
npm run modules -- list [--json]          # every known module: state, versions, flags
npm run modules -- install <id>
npm run modules -- enable <id>
npm run modules -- disable <id>
npm run modules -- upgrade <id>
npm run modules -- uninstall <id> --keep  # or --purge; no flag is refused, both is a usage error
npm run db:migrate                        # the core only; reports installed modules that need "modules upgrade"
npm run registry:generate [-- --dry-run] [-- --out <dir>]
npm run epnexo -- admin create --email <email> --name <name>
```

Every command takes `--modules-dir <path>` (default `modules/`; a path that is given must exist) and `--help`.
`list` flags are `upgrade-pending`, `orphaned`, `data-retained` and `invalid-version`. The CLI registry admits
modules whose `platform` the SDK does not satisfy, so they are listed and refused at install instead of breaking
every command.

`db:migrate` applies the core's migrations and nothing else. A module's schema changes only through the lifecycle:
`install` applies its first migrations and `upgrade` applies later ones, in the same locked action that records
`installed_version`, so the recorded version can never be out of step with the schema. For every installed module
(enabled or disabled) `db:migrate` checks, without applying, whether migration files are waiting and prints a
warning naming them: a newer package version needs `modules upgrade <id>`, and new files under an unchanged version
need the version raised first, because an upgrade to the same version is a no-op. An installed module whose package
is gone is reported as a warning and skipped. A module that was never installed is ignored, so it is not migrated,
refused for its `platform`, or shown as `data-retained`.
Discovery warnings go to stderr. After a successful install, enable, disable, upgrade or uninstall the CLI
prints a reminder that the registration must be regenerated and the web app rebuilt and restarted.

Exit codes: `0` done, `1` unexpected error or an accepted action that failed, `2` usage error, `3` refused by a
lifecycle rule, by a registration conflict or by an administrator rule.

### Administrators

Sign-in is email and password through [Better Auth](https://www.better-auth.com). Nobody can sign up: the public
sign-up endpoint refuses, and `admin create` is how an administrator comes to exist. Its password is read from
standard input, never from an argument, so it does not reach the process list or the shell history. On a terminal
it is asked twice without echo; from a pipe the first line is the password and only its line ending is dropped:

```bash
npm run epnexo -- admin create --email ada@example.com --name "Ada"            # hidden prompt
printf '%s\n' "$PASSWORD" | npm run epnexo -- admin create --email ada@example.com --name "Ada"
```

A password shorter than 12 characters and an email that already exists are refused with exit code `3`, and nothing
is created. The command needs `EPNEXO_MASTER_KEY` and a migrated database, and reads no module.

The authentication tables (`core.auth_user`, `core.auth_session`, `core.auth_account`, `core.auth_verification`,
`core.auth_rate_limit`) are created by the core migration `0003_auth.sql`. The library's own migrate command is
never run. A test compares that migration with the plan the installed library version computes, so upgrading the
library when it needs a schema change fails the suite until a new core migration is added.

## Registration codegen

Next.js resolves routes and client code at build time, so the web app cannot discover modules at run time.
`registry:generate` (or `generateRegistration` in `@epnexo/core`) turns the manifests of the **enabled** modules
into the files the web app needs, under `apps/web` unless `--out` says otherwise:

| File | Content |
| --- | --- |
| `src/generated/modules.ts` | static imports of each enabled module's manifest; `modules` in dependency order, the flattened `navigation` (ungrouped entries first, then groups by name, each by `order`, then label; carries `permission`) and `packageNames` for the bundler (`transpilePackages`). With no modules the three are empty arrays. |
| `src/app/<path>/page.tsx` | for `kind: "page"`: `export { default, metadata } from "<package>/<entry>"`, plus a literal `export const dynamic` when declared |
| `src/app/<path>/route.ts` | for `kind: "route"`: `export { GET, ... } from "<package>/<entry>"` for the declared methods |
| `src/generated/.manifest.json` | the files this generator owns and the package names |

A module is imported as `<package name>/<entry without "./" and extension>`, its manifest as
`<package name>/manifest`. A page entry must export `default` and `metadata`.

Every generated source file starts with a header saying it is generated and must not be edited. The generator is
idempotent and owns only what it wrote: a file from an earlier run that is no longer wanted (a module was
disabled or uninstalled) is removed together with the folders it emptied, a file it did not generate is never
deleted, and a needed path held by a hand-written file is an error. Conflicts are reported before anything is
written: two modules declaring the same normalised path, dynamic segments of one kind with different parameter
names at the same position under the same parent (`/items/[id]` and `/items/[itemId]/notes`: Next.js rejects
sibling dynamic folders with different names; the same name is fine), a dynamic segment whose brackets are not
balanced (only `[x]`, `[...x]` and `[[...x]]` exist), a path at or below a reserved shell path (`RESERVED_PATHS`: `/`, `/apps`, `/settings`, `/login`,
`/logout`, `/api`, `/_next`), and segments that cannot be a folder name. `--dry-run` prints the planned writes
and deletions and touches nothing.

A run is not atomic, but a run that fails partway can always be repaired by running the generator again. Before
touching any file it records, in `src/generated/.manifest.json`, everything the previous manifest listed plus
everything it is about to create or remove; only after all writes, deletions and folder removals have succeeded
is the manifest rewritten to the exact final list. After a failure the manifest is therefore a superset, and the
next run deletes whatever in it is no longer wanted and removes the empty folders left behind.

## Not here yet

Planned as later features: the shell UI and admin login (`apps/web`), the settings service and appearance, the
Apps screen with the install pipeline (package upload, build, restart - until then the CLI prints the reminder
and the regeneration, rebuild and restart are manual), and the module scaffold and packaging commands. A cleanup
path for orphaned rows is not designed.
