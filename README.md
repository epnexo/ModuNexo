# Modunexo

A module platform: a small core that installs, enables, disables, upgrades and uninstalls modules, each living
in its own repository, and generates the registration the web app needs from the modules that are enabled. This
repository holds the SDK modules compile against and the core. The feature plan lives in `odd/tasks/`.

## Layout

| Path | What it is |
| --- | --- |
| `packages/sdk` | `@modunexo/sdk`: manifest v2 types, `defineModule`, `validateManifest`, `getDb`, `getSetting`. |
| `packages/sdk-legacy-alias` | `@epnexo/sdk`, the pre-rename name, re-exporting the SDK for old modules. To be removed. |
| `packages/core` | `@modunexo/core`: the registry, migration runner, lifecycle, registration codegen and CLI. |
| `modules/` | Installed module packages, one folder per module, linked by the npm workspace glob. Not tracked in git. |
| `modules-src/` | Sources of the modules you write, made by `modules new`. Tracked in git. |
| `.claude/skills/modunexo-module/` | The skill that walks an author (or an agent) through building a module. |
| `apps/` | Applications built on the core. Empty today; the web shell is a later feature. |
| `odd/tasks/` | Feature documents. |

Everything is TypeScript consumed from source; there is no build step for packages. The core never imports a
module by name, and modules never import each other's code.

## Setup

```bash
npm install
docker compose up -d db      # Postgres 16 on 127.0.0.1:5436, compose project "epnexo-shell-core"
echo "DATABASE_URL=postgres://epnexo:epnexo@127.0.0.1:5436/epnexo" > .env   # local dev database
echo "TEST_DATABASE_URL=postgres://epnexo:epnexo@127.0.0.1:5436/epnexo_test" >> .env
echo "MODUNEXO_MASTER_KEY=$(openssl rand -base64 48)" >> .env
npm run db:migrate           # creates the core schema
npm run modunexo -- admin create --email you@example.com --name "Your Name"   # asks for the password
npm test                     # node:test through tsx, packages/*/test/**/*.test.ts
npm run typecheck            # tsc --noEmit
```

The only environment variables are infrastructure ones:

- `DATABASE_URL` - the database the CLI works on.
- `TEST_DATABASE_URL` - the database integration tests run on. Its name must end in `_test` and it must not be
  the development database. It is created on demand on the same server.
- `MODUNEXO_MASTER_KEY` - the one secret the platform reads from the environment, at least 32 characters
  (`openssl rand -base64 48`). The sign-in secret is derived from it, so there is no separate variable for it.
  Changing it signs every user out. Only the commands that touch authentication need it.
- `MODUNEXO_DATA_DIR` - optional: where received packages and the files modules store are kept (default `var/`). The web app and the worker must share it.

The project was called epnexo before it was renamed. `EPNEXO_MASTER_KEY` and `EPNEXO_DATA_DIR` still work as aliases
(the new name wins when both are set), and `npm run epnexo` still runs the CLI, so an existing `.env` and existing
scripts keep working. A few internal identifiers deliberately keep the old name for compatibility:

- the key-derivation context (`epnexo:<purpose>`), which must never change or stored secrets stop decrypting;
- the Postgres lock names, and the database, user and compose names (`epnexo`, `epnexo-shell-core`, and the
  `epnexo-*` volumes), so existing data volumes are reused;
- the package name `@epnexo/sdk`, kept as a thin alias of `@modunexo/sdk` (`packages/sdk-legacy-alias`) so modules
  written before the rename still build and pack; new modules import `@modunexo/sdk`, and the alias will be removed;
- the marker the code generator recognises, which still accepts the files an older version wrote.

No server answering, or neither variable set, **skips** the integration tests with the reason printed; a server
that answers but refuses (bad credentials, missing permission) **fails** the suite. With the database up,
`npm test` reports 0 skipped.

## Versioning

The platform has **one version**, written as the same number in `package.json`, `packages/core/package.json`,
`apps/web/package.json` and `CORE_VERSION` (`packages/core/src/version.ts`); a test fails if they differ. Find it with
`npm run modunexo -- --version` (it prints `modunexo 0.2.0 (sdk 0.1.0)`) or at the top of the Status screen.

The **SDK has its own number**, `SDK_VERSION`, because it is the contract with modules: a module's `platform` range is checked
against it. It rises only when that contract changes, and then on the usual rules for a `0.x` version: a new optional
capability raises the patch or minor, a break raises the minor (`^0.1.0` does not accept `0.2.0`). The platform can go from
`0.2.0` to `0.5.0` without any module being asked to change.

Releases follow [Semantic Versioning](https://semver.org/) and are written in `CHANGELOG.md`, newest first. To release:

1. Move what is new into a `## [x.y.z] - date` section of `CHANGELOG.md`.
2. Set `x.y.z` in the four places above (and `SDK_VERSION` with the SDK packages, only if the module contract changed).
3. Run `npm test`, merge to `main`, and tag the commit `vx.y.z`.


A module is a package under `modules/<id>/` with a `manifest.ts` that default-exports its manifest:

```ts
import { defineModule } from "@modunexo/sdk";

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
  `[id]`, `[...slug]` and `[[...slug]]` are allowed, with balanced brackets and nothing around them (`[id]]` is rejected). `kind: "page"` renders UI (the file must `export const metadata` beside its default export, because the generated route re-exports both), `kind: "route"` is an HTTP
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

## Building a module

```bash
npm run modunexo -- modules new field-notes --name "Field Notes"   # writes modules-src/field-notes/
npm run modunexo -- modules pack modules-src/field-notes --out field-notes.tgz
npm run modunexo -- modules add field-notes.tgz --sha256 <hex>     # review
npm run modunexo -- modules apply <hex>                            # install, rebuild, restart
```

`modules new` writes a module that already works: a manifest with one permission, nav entry and page, a first
migration and a page that lists and adds rows. It refuses an id that is not kebab-case or would give a reserved
schema, and never touches a folder that exists. The skill `.claude/skills/modunexo-module/SKILL.md` carries the full
procedure for an agent or a person.

### Data: `getDb`

A module reaches its own tables through the SDK, from a page, a server action or a route (never at import time):

```ts
import { getDb } from "@modunexo/sdk";

const db = getDb("field-notes");
const { rows } = await db.query<{ id: number; title: string }>("select id, title from items where id = $1", [id]);
await db.transaction(async (tx) => {
  await tx.query("insert into items (title) values ($1)", ["a"]);
  await tx.query("insert into items (title) values ($1)", ["b"]);   // both commit, or neither
});
```

- Every call runs in its own transaction with `search_path` fixed to the module schema for that transaction only, so
  `items` means `field_notes.items` and nothing leaks to the next user of the connection. Statements time out after
  30 s.
- One statement per `query`: the extended protocol refuses `a; b`, so a string cannot smuggle a second statement in.
  A lone `commit` or `reset` is still a statement the database accepts; a module that sends one gives up its own
  atomicity and its timeout. Another reason this is a contract and not a sandbox.
- A module that is not installed and enabled gets `DbAccessError` (`not-enabled`). Outside the running platform
  (a script, a test) `getDb` throws `DbUnavailableError`, like `getSetting`.

### Relating modules: `reader`

A module may **read** another module's data when it lists that module in `dependsOn` (which install already requires
to be present and in range):

```ts
const people = await getDb("field-notes").reader("contacts").query("select id, name from people");
```

The handle is `READ ONLY` in Postgres, so a write through it fails in the database with `25006`, not by convention.
A module that is not in `dependsOn` is refused by name (`not-a-dependency`), and `dependsOn` is one-way. There are no
cross-module writes: the other module exposes its own page or route, and you link by id.

This is the platform's contract for well-behaved modules, not a sandbox. Module code runs in the platform's process
with its database credentials, so a module that wants to can still reach around it. Install only what you trust.

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

One entry, `packages/core/src/cli/index.ts`, wired as npm scripts (`npm run modunexo -- <command>` runs any command):

```bash
npm run modules -- list [--json]          # every known module: state, versions, flags
npm run modules -- install <id>
npm run modules -- enable <id>
npm run modules -- disable <id>
npm run modules -- upgrade <id>
npm run modules -- uninstall <id> --keep  # or --purge; no flag is refused, both is a usage error
npm run modunexo -- modules new <id> [--name <text>] [--dir <parent>]   # a working module folder, default modules-src/<id>
npm run modunexo -- modules pack <folder> [--out <file>]
npm run modunexo -- modules add <archive> [--sha256 <hex>] [--json]
npm run modunexo -- modules apply <sha256> [--json]
npm run modunexo -- modules enable|disable|uninstall <id> --rebuild   # the change plus the rebuild and restart
npm run db:migrate                        # the core only; reports installed modules that need "modules upgrade"
npm run registry:generate [-- --dry-run] [-- --out <dir>]
npm run modunexo -- admin create --email <email> --name <name>
npm run modunexo -- auth status | require | disable
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
rule: a lifecycle rule, a registration conflict, an administrator rule, the sign-in mode or a package that is
refused (see "Module packages").

### Administrators

Sign-in is email and password through [Better Auth](https://www.better-auth.com). Nobody can sign up: the public
sign-up endpoint refuses, and `admin create` is how an administrator comes to exist. Its password is read from
standard input, never from an argument, so it does not reach the process list or the shell history. On a terminal
it is asked twice without echo; from a pipe the first line is the password and only its line ending is dropped:

```bash
npm run modunexo -- admin create --email ada@example.com --name "Ada"            # hidden prompt
printf '%s\n' "$PASSWORD" | npm run modunexo -- admin create --email ada@example.com --name "Ada"
```

A password shorter than 12 characters and an email that already exists are refused with exit code `3`, and nothing
is created. The command needs `MODUNEXO_MASTER_KEY` and a migrated database, and reads no module.

### Users and roles

More than one person can sign in. Every user has a role:

| Role | Can do |
|---|---|
| `admin` | everything: use the modules, add/enable/disable/uninstall apps, change settings, identity and sign-in |
| `operator` | use the modules (holds every module permission); cannot change the platform |

Any other stored role (the library's default `user`) signs in but holds no module permission. Users are managed from the
command line, so there is no screen to attack:

```bash
npm run modunexo -- user create --email bo@example.com --name "Bo" --role operator   # password from stdin, like admin create
npm run modunexo -- user list [--json]
npm run modunexo -- user role --email bo@example.com --role admin
```

`user role` refuses to demote the last active (not banned) administrator, so the platform cannot be left without one.
`admin create` still works and is `user create --role admin`.

The authentication tables (`core.auth_user`, `core.auth_session`, `core.auth_account`, `core.auth_verification`,
`core.auth_rate_limit`) are created by the core migration `0003_auth.sql`. The library's own migrate command is
never run. A test compares that migration with the plan the installed library version computes, so upgrading the
library when it needs a schema change fails the suite until a new core migration is added.

## Registration codegen

Next.js resolves routes and client code at build time, so the web app cannot discover modules at run time.
`registry:generate` (or `generateRegistration` in `@modunexo/core`) turns the manifests of the **enabled** modules
into the files the web app needs, under `apps/web` unless `--out` says otherwise:

| File | Content |
| --- | --- |
| `src/generated/modules.ts` | static imports of each enabled module's manifest; `modules` in dependency order, the flattened `navigation` (ungrouped entries first, then groups by name, each by `order`, then label; carries `permission`) and `packageNames` for the bundler (`transpilePackages`). With no modules the three are empty arrays. |
| `src/app/(shell)/<path>/page.tsx` | for `kind: "page"`: `export { default, metadata } from "<package>/<entry>"`, plus a literal `export const dynamic` when declared |
| `src/app/(shell)/<path>/route.ts` | for `kind: "route"`: `export { GET, ... } from "<package>/<entry>"` for the declared methods |
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
balanced (only `[x]`, `[...x]` and `[[...x]]` exist), a path at or below a reserved shell path (`RESERVED_PATHS`: `/`, `/apps`, `/settings`, `/status`, `/login`,
`/logout`, `/api`, `/_next`; `/hooks` is reserved for public routes), and segments that cannot be a folder name. `--dry-run` prints the planned writes
and deletions and touches nothing.

A run is not atomic, but a run that fails partway can always be repaired by running the generator again. Before
touching any file it records, in `src/generated/.manifest.json`, everything the previous manifest listed plus
everything it is about to create or remove; only after all writes, deletions and folder removals have succeeded
is the manifest rewritten to the exact final list. After a failure the manifest is therefore a superset, and the
next run deletes whatever in it is no longer wanted and removes the empty folders left behind.

## Not here yet

Planned as later features: enable, disable and uninstall from the Apps screen (they need a rebuild pipeline of
their own), and the module scaffold. A cleanup path for orphaned rows is not designed.

### Sign-in mode

Sign-in is required by default. For an instance that lives only on a trusted local network it can be switched off,
and switched back on when the instance is exposed:

```bash
npm run modunexo -- auth status     # sign-in: required | disabled
npm run modunexo -- auth disable
npm run modunexo -- auth require
```

The mode is stored in the database (`core.platform_settings`, key `auth.signIn`), so it does not need the master
key and can be changed while locked out. Three rules keep it from becoming an open door:

- Anything other than the exact stored value `disabled` means *required*. A missing, corrupted or hand-edited row
  never opens the shell.
- With sign-in disabled the shell serves **local requests only**: a request is refused when any address it carries
  is not loopback, private (RFC 1918), link-local or IPv6 unique-local. Shared address space (100.64.0.0/10) is not
  local. An address that cannot be read is not local.
- `auth require` is refused (exit code `3`) while no active administrator exists, so it cannot lock you out.

With sign-in disabled there is no session, and anyone on the local network can use the shell as an operator with
every permission, including installing modules, which runs code with access to the database.

## Web app

`apps/web` is the Next.js shell. It reads the same `.env` as the CLI.

```bash
npm run web:build     # regenerates the module registry from the database, then runs next build
npm run web:start     # production server
npm run web:dev       # development server
```

`WEB_HOST` (default `127.0.0.1`) and `WEB_PORT` (default `3000`) choose where it listens; use `WEB_HOST=0.0.0.0` to
serve the local network. `WEB_PUBLIC_URL` is optional and describes the proxy or tunnel in front of the app, such as
`https://modunexo.example.com`: left unset the app serves plain HTTP on the local network and its session cookie works
there; set to an `https` origin the cookie becomes `Secure`. It must be a bare origin, with no path. `web:start` and `web:dev` refuse to start without `MODUNEXO_MASTER_KEY` and say so in one
line. Installing, disabling or uninstalling a module changes the registry: run `web:build` and restart.

### The shell

Every page sits in the `(shell)` route group, whose layout draws the sidebar and the top bar. Generated module
routes are written into that same group (`src/app/(shell)/<path>`), so a module's pages get the shell without
knowing about it; only `/login` stands outside. The sidebar is the shell's own entries (Home, Apps, Settings) and
then the enabled modules' `nav` entries, grouped and ordered as their manifests declare. An entry that names a
`permission` is shown to the local operator, to an `admin` and to an `operator`, and the gate enforces the same rule on
the route (see "Permissions" below), so a link that is hidden cannot be reached by typing its address.

A manifest `nav.icon` names one of: `app`, `home`, `apps`, `settings`, `dashboard`, `documents`, `chart`,
`megaphone`, `users`, `database`, `mail`, `calendar`, `folder`, `shield`, `bolt`. Anything else gets the generic
icon. The theme (light or dark) follows the system preference until it is switched from the top bar; the choice is
kept in the browser. Colors, radius, fonts and motion durations are the variables in
`apps/web/src/styles/tokens.css`, and nothing else in the app hard-codes one.

### Who gets in

Every request goes through `src/proxy.ts`, which gathers four facts (the sign-in mode, whether there is a valid
session, the path, and whether the request is local) and asks `decideAccess` in `src/server/access.ts`:

| Sign-in | Visitor | Result |
| --- | --- | --- |
| required | no session | pages redirect to `/login`, `/api/*` answers `401` |
| required | session | served; `/login` redirects to `/` |
| required | no session, path is a declared public route | served; the route checks its own signature (see "Public routes") |
| required | no session, path is a declared token route | served; the route checks the bearer token and its scope (see "Service tokens") |
| disabled | local request | served; `/login` redirects to `/` |
| disabled | any non-local address | `403 Forbidden`, whatever the path |
| disabled | `Host` is not a local name | `403 Forbidden`, whatever the path |

A failure while gathering those facts is a `503`, never an allow. A session whose user is banned stops working at
once, even when the ban was written straight to the database. Failed sign-ins are limited to 5 per minute per
connection address.

While sign-in is disabled the `Host` header must be a local IP literal, `localhost`, a single-label name
(`raspberrypi`) or a name under `.local`, `.lan`, `.home.arpa`, `.internal` or `.localdomain`. That is what stops
DNS rebinding (a page on a public domain made to resolve to a local address) and a public reverse proxy that
forwards no client address. The refusal body is always the bare `Forbidden`; the server log says why, once a minute
per reason, and how to ask for a sign-in again.

The web server is the platform's own thin Node server (`apps/web/scripts/serve.ts`) in front of Next.js. Next.js
fills `x-forwarded-for` from the socket only when the client did not send one, so a route could not tell a real
address from a forged one. The server therefore sets `x-modunexo-client-ip` from the connection on every request and
discards any copy a client sent. Whether a request is local is judged on that address and on every address a
proxy reports (`x-forwarded-for`, `forwarded`, `x-real-ip`, `cf-connecting-ip`, `true-client-ip`, `x-client-ip`):
one public address anywhere is enough to refuse it. A request that was not stamped has no trusted address and is
never local.

Behind a reverse proxy on the same machine the connection address is the proxy's (loopback). Two things keep a public
client out while sign-in is disabled: the addresses the proxy forwards, and the public name it serves under, which
the `Host` rule refuses. Two limits remain, so leave sign-in required for anything exposed to the internet:

- The sign-in limit is keyed on the connection address, so behind such a proxy all visitors share one bucket and
  someone can lock the administrator out for a minute at a time. Telling the app which proxies to trust is part of
  the settings feature.
- A proxy that rewrites `Host` to a local name and forwards no client address looks local.

A browser request is trusted when its `Origin` names the `Host` it was sent to, so the app works under whatever
address or name it is reached by; forwarding headers are never consulted for that check.

## Settings and appearance

Everything below is stored by the platform in the database; none of it needs an environment variable.

### What a module declares and how it reads it

A manifest lists the settings it needs under `settings`: `key`, `label`, `type` (`string`, `number`, `boolean`,
`select`, `secret`, `path`), and optionally `default`, `required`, `options` and `description`. The platform
stores the values, validates every change against the declaration, and edits them on the **Settings** screen and
with `modunexo settings`. A module's server code reads its own settings with the SDK:

```ts
import { getSetting } from "@modunexo/sdk";

const title = await getSetting("my-module", "report.title"); // stored value, else the default, else null
```

`getSetting` works inside the running web app (a page, a server component, an API route). Called from a script
or a test it throws `SettingsUnavailableError`, saying so. A `secret` comes back decrypted, for server code only:
never render it or put it in a response.

What each type accepts: `string` any non-blank text up to 2,000 characters; `number` a decimal number (`1e3` and
`0x10` are refused); `boolean` `true` or `false`; `select` one of the declared options; `path` an absolute path
without `..` segments; `secret` any non-empty text up to 4,096 characters. A required setting with neither a value
nor a default shows as incomplete on the screen and in `settings list`; it does not stop the module from running,
so the module decides what to do without it.

### Public routes

A module can accept calls from outside, such as a messaging provider's webhook, by marking a `kind: "route"` page
`public`. A public route has no session, so the shell makes it safe by construction instead of leaving that to each
module:

```ts
settings: [{ key: "webhook_secret", label: "Webhook secret", type: "secret", required: true }],
pages: [
  {
    path: "/hooks/inbox/messages",           // always /hooks/<module-id>/...
    entry: "./web/messages.ts",
    kind: "route",
    methods: ["POST"],                       // required; GET, HEAD and OPTIONS carry no body to sign
    public: {
      signature: { secret: "webhook_secret", header: "x-signature", encoding: "hex", prefix: "sha256=" },
      ratePerMinute: 60,                     // optional, default 60 per client
      maxBodyBytes: 1048576,                 // optional, default 1 MiB
    },
  },
],
```

- **Where.** Public routes live under `/hooks/<module-id>/` and nowhere else; no other page may sit under `/hooks`
  (`/api` stays reserved). A `public` route cannot also declare a `permission`.
- **Signature.** The generated route file wraps every method with `publicRoute` (`src/server/public-route.ts`). It
  computes HMAC-SHA256 over the raw body with the module's `secret` setting and compares it in constant time with the
  header. The module handler runs only after that, and receives the same bytes. A missing or empty secret, a missing
  or malformed header or a mismatch all answer the same `401 Unauthorized`; the log says why.
- **Replay window.** With `timestampHeader` the signed text is `<timestamp>.<body>` (Unix seconds) and a request
  further than `toleranceSeconds` (default 300) from the server clock is refused. Providers that send no timestamp
  cannot be protected against replay by the shell; the module must deduplicate (see below).
- **Limits.** `413` above `maxBodyBytes`, checked from `Content-Length` and while reading; `429` with `Retry-After`
  above `ratePerMinute` per client address, counted before the signature is checked. The count lives in the process's
  memory, so each instance keeps its own.
- **Gate.** The gate treats a path as public only when every way the router could read it (encoded and double
  encoded forms included) lands on a declared public route; anything else meets the ordinary gate. With sign-in
  disabled the local-only rule still applies, so a webhook cannot reach a shell that is not open to the network:
  public routes need `auth require`.
- **Idempotency is the module's.** The shell does not deduplicate deliveries. A module should store the provider's
  event id under a unique constraint and ignore repeats.
- **Not covered yet.** Providers that verify with a handshake instead of a signature (a `GET` carrying a challenge)
  cannot be declared public.
- **Install review.** `modules add` and the Apps screen list public routes separately, because installing the module
  opens them.

### Service tokens

A module can offer an API to machine callers (an agent, a script, another service) with service tokens. The module
declares the scopes it understands and marks the routes that need one; the shell checks the token before the module
code runs:

```ts
scopes: [
  { key: "messages.read", label: "Read messages" },
  { key: "messages.send", label: "Send messages" },
],
pages: [
  { path: "/svc/inbox/messages", entry: "./web/messages.ts", kind: "route", methods: ["GET"], scope: "messages.read" },
  { path: "/svc/inbox/send",     entry: "./web/send.ts",     kind: "route", methods: ["POST"], scope: "messages.send" },
],
```

```bash
npm run modunexo -- tokens create inbox --name "agent" --scope messages.read [--expires-in-days 90]   # prints the token once
npm run modunexo -- tokens list [inbox] [--json]                                                       # never the token
npm run modunexo -- tokens revoke <id>
curl -H "Authorization: Bearer mdnx_..." https://host/svc/inbox/messages
```

- **Where.** Token routes live under `/svc/<module-id>/` and nowhere else; no other page may sit under `/svc`. A route
  declares `scope` instead of `permission` or `public`, never together.
- **The token.** `mdnx_<8 hex>_<43 characters>`, 32 random bytes. The platform stores only its SHA-256 (migration
  0010, `core.service_tokens`), so a copy of the database holds no usable token, and the token is shown once, by
  `tokens create`. A token is issued for scopes its module declared (anything else is refused, exit code 3), belongs
  to that module alone and can have an expiry.
- **Checks.** The generated route file wraps every method with `scopedRoute` (`src/server/scoped-route.ts`). A request
  with no bearer token, an unknown, malformed, revoked or expired token, or a token of another module answers the same
  `401 Unauthorized` with `WWW-Authenticate: Bearer`; the log says which. A valid token that lacks the route's scope
  answers `403`. If the platform cannot reach its database the answer is `503`, never an allow. Revoking takes effect
  on the next request, with no restart.
- **Limits.** 120 requests a minute per client address and route, answered `429` with `Retry-After` before the token is
  looked up; the count lives in the process's memory. The shell does not read or cap the body of a token route: the
  module's handler does. `last_used_at` is updated at most once a minute per token.
- **Gate.** The same rule as for public routes: a path is a token route only when every way the router could read
  it lands on a declared one, and with sign-in disabled the local-only rule still applies, so token routes need
  `auth require` to be reachable from outside.
- **Lifecycle.** `uninstall --purge` deletes the module's tokens (the trail in `core.service_token_events`, which holds
  no token, stays). `uninstall --keep` and disabling keep them, so reinstalling the module revives the same tokens.
  The install review lists the module's scopes and its token routes.
- **Not here yet.** A screen to manage tokens (the CLI is the only way), rotation, and per-token rate limits.

### Background jobs

A module can run work outside a request: a sync, a cleanup, a retry. It declares the job, writes the handler and
enqueues runs (or lets the platform repeat it); a separate **worker process** runs them.

```ts
jobs: [
  { name: "sync", entry: "./jobs/sync.ts", timeoutSeconds: 120, maxAttempts: 5 },
  { name: "cleanup", entry: "./jobs/cleanup.ts", every: "1h" },        // repeats: 1h after each run finished
],
```

```ts
// jobs/sync.ts: the default export is the handler
import { getDb, getSetting, type JobContext } from "@modunexo/sdk";
export default async function (ctx: JobContext) {
  const { payload, attempt, signal } = ctx;                              // signal aborts at timeoutSeconds
  await getDb(ctx.moduleId).query("insert into synced (n) values ($1)", [1]);
}

// from a page or route handler, or from another job
import { enqueueJob } from "@modunexo/sdk";
await enqueueJob("inbox", "sync", { page: 2 }, { delaySeconds: 30, dedupeKey: "sync-2" });
```

```bash
npm run modunexo -- worker [--concurrency 4] [--poll-ms 1000] [--grace-seconds 30]   # runs until SIGINT/SIGTERM
npm run modunexo -- jobs list [inbox] [--status dead] [--json]       # the payload only with --json
npm run modunexo -- jobs enqueue inbox sync --payload '{"page":2}' [--delay-seconds 30] [--dedupe-key k]
npm run modunexo -- jobs cancel <id>                                  # queued only
npm run modunexo -- jobs retry <id>                                   # dead only, from the first attempt
```

- **The queue is Postgres** (`core.jobs`, migration 0011). A worker claims due jobs with `for update skip locked`, so
  several workers can run side by side and no job runs twice at once. Only jobs of **enabled** modules are claimed;
  a disabled module's jobs wait.
- **Handlers.** The worker loads the handler from the module's folder, in its own process, and registers what a request
  has: `getDb`, `getSetting` and `enqueueJob`. The code is loaded once, so **restart the worker after installing or
  upgrading a module**. The master key is needed only if a handler reads a `secret` setting.
- **Time limits.** `timeoutSeconds` (default 60, at most 3600): the handler's `signal` aborts and the attempt is marked
  failed. A handler that ignores the signal keeps running in the background of the worker, so watch it.
- **Retries.** A failure queues the job again after 10 s, doubling each attempt up to an hour, until `maxAttempts`
  (default 5); then it is `dead` (see `jobs list --status dead`, `jobs retry`). The error message is kept, cut at
  1000 characters.
- **Retrying.** `jobs retry` refuses (exit 3) when the dead job's dedupe key is held by another job, as happens after a
  dead scheduled run: the next run is already queued.
- **Dead workers.** A running job holds a lease of `timeoutSeconds` + 30 s. If the worker dies, the lease expires, the
  next tick gives the job back (that attempt counts) and nobody can overwrite the result of the job another worker now
  holds. At-least-once: write handlers so that running twice is harmless, or use `dedupeKey` and your own checks.
- **Schedules.** `every` (`"30s"`, `"5m"`, `"2h"`, `"1d"`; 10 seconds to 30 days) keeps exactly one active run: the next is
  queued `every` after the previous finished, also after a dead one, and after a pause it runs once, not once per
  missed interval. Intervals only, no cron expressions.
- **Enqueue.** The module must be enabled and have declared the job; the payload must be JSON of at most 64 KiB. With a
  `dedupeKey`, a second enqueue while a job with that key is queued or running returns the existing one
  (`deduplicated: true`).
- **Stop.** The first SIGINT or SIGTERM stops claiming (also in the middle of a tick) and waits up to `--grace-seconds`
  (default 30) for running jobs; what is left keeps its lease, the worker exits with code 0 right away, and another
  worker recovers those jobs when the lease expires. A second signal exits at once. Give a container a stop period
  longer than the grace (the compose file uses 40 s).
- **Clocks.** The workers stamp leases with their own clock: keep them in sync (NTP). A skew above the 30 s lease
  grace can make a worker recover a job that is still running and run it twice.
- **Trust.** Module code is trusted, and `enqueueJob` takes any module id: a module can queue another module's declared
  job, set its payload or take its dedupe key. Install only packages whose source you trust.
- **History.** Finished jobs stay 14 days and are pruned by the worker. `uninstall --purge` deletes the module's jobs.
- **Docker.** The `worker` service in `docker-compose.yml` (profile `app`) runs the same image with `modunexo worker`.
- **Not here yet.** Cron expressions, a per-job concurrency limit, a screen to see jobs, a worker health endpoint, and
  hot reload of handler code.

### Events and realtime

A module announces that something happened with an **event**. Other modules react to it through a job, and a signed-in
browser can follow it live. The module registers its event types in the manifest, so there is no closed list.

```ts
permissions: [{ key: "inbox.read", label: "Read the inbox" }],
events: [
  { name: "message.received", permission: "inbox.read" },   // full type: inbox.message.received; streamed to browsers
  { name: "sync.finished" },                                 // no permission: never sent to a browser
],
// in another module, which must list "inbox" in dependsOn (or in the module itself):
jobs: [{ name: "reply", entry: "./jobs/reply.ts" }],
subscriptions: [{ event: "inbox.message.received", job: "reply" }],   // the job gets { event: { id, type, payload, createdAt } }
```

```ts
// Publish inside the transaction that wrote the data: the event exists exactly when the data does.
import { getDb, publishEvent } from "@modunexo/sdk";
await getDb("inbox").transaction(async (tx) => {
  await tx.query("insert into messages (body) values ($1)", [body]);
  await publishEvent("inbox", "message.received", { body }, { tx });   // last step: see the note on locking
});
await publishEvent("inbox", "sync.finished");                          // or alone, in a transaction of its own
```

```js
// In the browser: Last-Event-ID is sent by EventSource itself when it reconnects.
const stream = new EventSource("/api/events?types=inbox.message.received");
stream.addEventListener("inbox.message.received", (e) => render(JSON.parse(e.data)));   // { id, type, payload, createdAt }
stream.addEventListener("reset", () => reload());                                        // events were missed: fetch the state again
```

```bash
npm run modunexo -- events list [inbox] [--type inbox.message.received] [--limit 50] [--json]   # the payload only with --json
npm run modunexo -- events publish inbox message.received --payload '{"body":"hi"}'
```

- **The log is Postgres** (`core.events`, migration 0012). `id` is the position in the log and the cursor. The payload is
  JSON of at most 16 KiB. The module must be enabled and have declared the event.
- **Order.** Publishing takes a database lock before the id is assigned and keeps it until commit, so events become
  visible in id order and a cursor can never skip one. The cost is that publishers wait for each other: keep the
  transaction short and publish as its last step. Two transactions that publish and then touch each other's rows can
  deadlock; Postgres aborts one of them.
- **Jobs from events.** In the publisher's transaction the platform queues the subscribed job of every **enabled**
  subscriber (the job then runs, retries and dies as any job). A module that is disabled misses the event and does not
  catch up. Subscribing needs `dependsOn` like the read-only SQL channel, and a subscription whose event the other
  module never declared simply never fires.
- **The stream** `GET /api/events` is behind the gate like any `/api` path (a session, or a local request while sign-in is
  off). It sends `retry`, then the events after the cursor (`?after=` or `Last-Event-ID`), then new ones, plus a
  comment line every 20 s. An event is sent only if its module tied it to a `permission` that the viewer holds and the
  module is enabled; the answer is 403 for a viewer who may follow nothing, and 400 for an unknown or unstreamed type, a
  bad cursor or more than 20 types. Past 200 open streams in a process, 503.
- **Catching up.** A client that reconnects with a cursor gets what it missed. If the cursor is older than the oldest
  kept event, comes from another database, or more than 1000 events behind, the stream starts with `event: reset`: fetch
  the state again, then continue from the id it carries. A client that cannot keep up (500 frames queued) is
  disconnected and resumes by cursor. A server restart closes streams; `EventSource` reconnects by itself.
- **Across processes.** Each web process keeps one connection that `LISTEN`s for the database's announcement, which is
  delivered at commit, and also reads on a timer (5 s) and after any reconnect, so a lost announcement delays an event
  without dropping it. Events published by the worker or the CLI reach every stream.
- **History.** Events are kept 7 days (the worker prunes them) and `uninstall --purge` deletes the module's events.
- **Trust.** `publishEvent` takes any module id, like `enqueueJob`: module code is trusted. Do not put secrets in a
  payload that a browser may receive.
- **Not here yet.** A React hook for the stream, delivery receipts per subscriber beyond the job's own, replaying events to
  a module that was disabled, wildcard types, and a screen for the stream.

### Stored files

A module keeps files (attachments, exports, images) through the SDK instead of writing to the disk itself. The bytes sit
behind a storage adapter (a folder on disk today, object storage later), so no module changes when the adapter does.

```ts
permissions: [{ key: "inbox.read", label: "Read the inbox" }],
files: { maxBytes: 5 * 1024 * 1024, accept: ["image/*", "application/pdf"], permission: "inbox.read" },
// maxBytes: default 10 MiB, at most 50 MiB. accept: up to 20 types or families, default any.
// permission: who may download from a browser. Without it no browser can.
```

```ts
import { deleteFile, getFile, listFiles, putFile, statFile } from "@modunexo/sdk";
// In a route: the request body is the file. Pass the stream; it is never held in memory whole.
const meta = await putFile("inbox", { name: "invoice.pdf", data: request.body!, ref: "message:42" });   // { id, name, contentType, size, sha256, ref, createdAt }
// Inside a transaction, so the file exists exactly when your row does:
await getDb("inbox").transaction(async (tx) => {
  const file = await putFile("inbox", { name, data }, { tx });
  await tx.query("insert into attachments (message_id, file_id) values ($1, $2)", [messageId, file.id]);
});
const found = await getFile("inbox", id);        // { meta, stream } or null; another module's id is null too
await listFiles("inbox", { ref: "message:42" }); // newest first, default 100, at most 500
await deleteFile("inbox", id);                   // true, or false when the module has no such file
```

```sh
npm run modunexo -- files list [inbox] [--limit 50] [--json]   # never the content
npm run modunexo -- files delete inbox <file-id>
```

- **The type comes from the bytes.** The platform looks at the first bytes (PNG, JPEG, GIF, WebP, PDF, ZIP, gzip, plain
  UTF-8 text, else `application/octet-stream`); a name or a type the caller claims is never believed. HTML, SVG and script
  are plain text to it, so nothing a browser would run is ever announced as such. `accept` filters on that type.
- **Names are never paths.** The name you give is kept only for display and for the download; separators, control and
  invisible characters are removed and it is cut to 200 characters. Bytes live under `<module>/<two characters>/<uuid>`.
- **Limits.** The body is counted as it is written; a file over the limit, empty, or of a type the module does not take is
  refused and nothing is left behind. The platform has no multipart parser: your route reads its own body and decides its
  own protocol (a raw body with the name in a header is the simplest).
- **Download.** `GET /api/files/<module>/<id>` is behind the gate like any `/api` path and also needs the module's
  `files.permission` (administrators and the local operator hold every module permission). It is always sent as an
  attachment, with `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`; a module that
  is unknown, stores no files or is disabled answers 404 like a missing file. Machine callers get a file through a route of
  yours that checks its own token.
- **Rows and bytes are two stores.** `core.files` (migration 0013) holds the row, the data directory holds the bytes
  (`MODUNEXO_DATA_DIR/files`, shared by the web app and the worker: give both the same directory, as the compose file does).
  With `tx`, the bytes are written first and the row commits with your transaction; if it rolls back the bytes are left
  without a row, and the worker removes bytes older than a day that no row describes (and half-written uploads older than an
  hour) every hour. `deleteFile` removes the row, then the bytes.
- **Lifecycle and backup.** `uninstall --purge` deletes the module's rows and its folder of bytes (`--keep` leaves both).
  `scripts/backup.sh` saves `files.tar.gz` and `restore.sh` brings it back.
- **Not here yet.** An object-storage adapter, thumbnails, a virus-scan hook, quotas on a module's total, expiring links for
  callers outside the platform, and an upload route owned by the platform.

### Language models

A module asks a chat model through the SDK and holds no HTTP, no provider code and no key. The endpoint, the key and the
model are the module's own settings, so the settings screen is the configuration screen and the key is a stored secret. The
wire format is OpenAI-compatible, which also covers local servers (Ollama, vLLM, LM Studio, llama.cpp).

```ts
settings: [
  { key: "llm.url", label: "Model endpoint", type: "string" },       // https://api.openai.com/v1  or  http://127.0.0.1:11434/v1
  { key: "llm.key", label: "API key", type: "secret" },               // optional: a local server needs none
  { key: "llm.model", label: "Model", type: "string" },               // the default; a call may name another
],
llm: { baseUrlSetting: "llm.url", apiKeySetting: "llm.key", modelSetting: "llm.model" },   // only the first is required
```

```ts
import { LlmError, chat, probeLlm } from "@modunexo/sdk";
try {
  const reply = await chat("agent", { messages: [{ role: "system", content: "Answer briefly." }, { role: "user", content: text }], temperature: 0.2, maxTokens: 300 });
  reply.content;       // the text; also reply.model, reply.finishReason and reply.usage ({ promptTokens, completionTokens, totalTokens } or null)
} catch (error) {
  if (error instanceof LlmError) error.code;   // not_configured | invalid_request | unreachable | timeout | unauthorized | rejected | rate_limited | bad_response | too_large
}
const check = await probeLlm("agent");   // { endpoint, latencyMs, models (at most 50), model, modelAvailable }
```

```sh
npm run modunexo -- llm probe agent [--json]    # reached http://127.0.0.1:11434/v1 in 12 ms / models (3): ... / model "x": available
```

- **Settings are read on every call.** Changing the endpoint, the key or the model on the settings screen applies at once, in
  the web app and in the worker. A call from a route or from a job is the same call.
- **Limits.** 1 to 200 messages and at most 200,000 characters; `temperature` 0 to 2; `maxTokens` 1 to 32768. A request that
  breaks them is refused as `invalid_request` before any network call. A call times out after 60 s (pass a `signal` to stop
  sooner) and a reply is read up to 2 MiB.
- **The key.** It is decrypted only when a call is made and goes only to the configured host as `Authorization: Bearer`. It is
  never logged, never in an error (the provider's own error text is cut to 200 characters and has the key removed) and never
  in a result. A redirect is never followed, so a server cannot bounce the key to another host. The URL must be `http` or
  `https` with no user name, query or fragment.
- **Private addresses are allowed on purpose.** A local model is the main use, and the URL is set by an administrator on the
  settings screen, not by a caller. Do not let module code build the URL from user input.
- **Not here yet.** Streaming, tools or function calling, embeddings, images, retries with backoff, a usage or cost log and
  quotas, several providers per module, and a provider that does not speak the OpenAI format (the provider sits behind a small
  interface, so one can be added).

### The Status screen

`/status` ("Status" in the sidebar) shows an administrator what the background capabilities are doing, so the work of jobs,
events, files and models can be seen without the command line. Anyone else who opens it is told that only an administrator
can, and nothing is read for them. With sign-in off, the local operator is the administrator. It has four tabs, one concern at
a time:

- **Jobs.** For each module that has jobs: how many are queued, running, succeeded, dead and cancelled. Under it, the newest 20
  jobs that need a look: the dead ones and those waiting for a retry, with the module, the job, attempts, when, and what the
  job last reported (cut to 200 characters). When jobs have been due for a minute and nobody took them, a line asks whether the
  worker is running and says how to start it (`npm run modunexo -- worker`); that is an inference, since nothing records that a
  worker is alive.
- **Events.** The newest 50 (id, module, type, when). Events are kept 7 days.
- **Files.** For each module that stores files, how many and their total size.
- **Model.** For each enabled module that declares `llm`: which settings configure it, and a **Test connection** button that
  asks the provider for its models and shows where it went, how long it took, how many models it lists and whether the module's
  model is among them, or the refusal with its code. The button is `POST /api/status/llm/<module>`: administrators only, from
  this site only. It changes nothing here.

What it does not show, on purpose: the data a job was given, what an event carries, a file's name, ref or hash, and any key. What a
job "last reported" is the message of whatever its code threw; it is shown as plain text and may be more than you wish to share,
so look before you share a screenshot. It does not refresh by itself (reload), and it offers no retry or cancel yet. `/status`
is reserved for the shell: a module cannot declare a page there.

### A real module: inbox

`modules-src/inbox/` is the first module that does business work, and it uses most of the capabilities above: a public route,
a job, an event, secret settings and a live page. Pack and install it like any other (`modules pack`, `modules add`,
`modules apply`), then set its three settings on `/settings`.

- **Receive.** A channel posts JSON to `POST /hooks/inbox/messages`, signed with HMAC-SHA256 of the body in the header
  `x-signature: sha256=<hex>`, keyed by the secret setting `webhook_secret`. The body is `channel` (lowercase, up to 32
  characters), `threadRef`, `messageId`, `text` (1 to 4000 characters) and optionally `contact: { ref, name }`. The answer is
  `{ "ok": true, "duplicate": false }`; a message already delivered (same `channel` and `messageId`) answers `duplicate: true`
  and changes nothing. A body that cannot be used answers 400 with the reason.
- **Show.** `/inbox` lists the newest 50 conversations and shows the selected one with its newest 200 messages. Opening a
  conversation marks it read. A new message refreshes the page by itself through `inbox.message.received`.
- **Reply.** The form posts to `/inbox/reply` (permission `inbox.write`, same site only). The reply is stored as `queued`
  and the job `deliver` posts it, signed with `outbound_secret` in the same way, to the setting `outbound_url`; it becomes
  `sent`, or `failed` with the reason after 5 attempts. The reason is the HTTP status or a fixed phrase, never the URL or
  the provider's answer. Without an outbound URL a reply stays `queued` and the page says so. The URL must be `http` or `https`
  (any other scheme fails the reply at once), and it is whatever an administrator sets, so point it only at a service you trust.
  Delivery is at-least-once: if the worker stops after the provider accepted a reply and before it was marked `sent`, the reply is
  sent again, so the receiving side should ignore a `messageId` it has already seen.
- **Permissions.** `inbox.read` opens the page and receives the event; `inbox.write` can reply. A page cannot ask the SDK
  who is looking, so the reply form is shown to everyone who can read and the gate refuses the send to the rest.
- **Not yet.** Attachments, adapters for WhatsApp, Instagram or Messenger (their `GET` handshake cannot be a public route
  yet), assigning conversations, search, deleting, and sending replies that were queued before an outbound URL was set. The
  AI agent is an external service that talks to this module with a service token, not part of it.

### Secrets

A `secret` is stored encrypted with AES-256-GCM under a key derived from `MODUNEXO_MASTER_KEY`, bound to its module
and key, so a stored value cannot be moved to another setting. It is write-only: the screen, the CLI, the API and
the audit trail only ever say that one is set. Changing the master key makes the stored secrets unreadable: the
screen flags them, and each is replaced by typing it again. Nothing else breaks.

### The screen and the API

`/settings` shows Appearance and one section per enabled module (its declared settings, and its appearance
override). Only an administrator, or the local operator while sign-in is off, can see or change anything; anyone
else is told so and shown no value. A module counts as enabled only when the database says so, so a build that has
not been rebuilt since an uninstall cannot bring a purged module's settings back. The screen saves through `PUT /api/settings/appearance`,
`PUT /api/settings/modules/<id>` and `PUT /api/settings/modules/<id>/appearance`. Each insists on a same-origin
request (`Origin` naming the `Host`) and on an administrator or the local operator, and a form with one bad field
changes none of its fields: the response names each refused key. A form is applied as one transaction, and a body is
cut off at 64 KB while it is being read, not after. The origin check compares `Origin` with the `Host` the request
arrived with, so behind a proxy that rewrites `Host` a legitimate save is refused (never wrongly accepted); have
the proxy pass `Host` through.

### Profile (business or person)

The first time an administrator opens the shell, with no profile saved, every page sends them to `/setup`, where they
say whom the platform belongs to. That choice, business or person, is made once: Settings afterwards edits the details
but shows the kind locked, and `PUT /api/settings/brand` answers `409` to a change of kind. The only way to change it
is **Reset identity** (a danger zone in Settings, or `DELETE /api/settings/brand` with `{ "confirm": "<current name>" }`):
it removes the profile and the logo, never any CRM data, and brings the setup back.

- **A business** needs a name, a legal representative and a contact email; website, phone, tax id and address are
  optional. **A person** needs a name and may add an email and a photo; without one the shell draws a monogram (initials on a
  color the person picks).
- The logo or photo replaces `modunexo` in the sidebar, the mobile bar, the sign-in page and the page titles, and a
  business also gets a footer with its name, website, email and phone.
- The image is PNG, JPEG or WebP, up to 512 KB, and is checked by its bytes, not its name. SVG is refused because it
  can carry script. It is stored in `core.brand_assets` (migration 0009); the profile text is the setting
  `brand.profile` in `core.platform_settings`. Every change is a row in `core.settings_events`.
- `PUT /api/settings/brand` (the profile as JSON) and `DELETE` (back to the default), `PUT|DELETE /api/brand/logo`
  (the raw image) are administrator-only and same-origin. `GET /api/brand/logo` is public, and is the only public
  path besides the sign-in page, so the sign-in page can show the logo; it is served with `nosniff` and a
  sandboxing content security policy, with an `ETag` of the file's hash.

### Appearance

The platform has three appearance settings: the default theme (`system`, `light`, `dark`), the accent hue (0 to
360) and the corner radius (`sharp`, `default`, `round`). They change design tokens and nothing else: the only
values that ever reach a stylesheet are a number and one of three names, so there is no free CSS to inject. A
visitor's own theme choice, kept in their browser, wins over the default.

A module may override the accent hue and the corners for its own pages. The shell marks the content area with
`data-module="<id>"` and the overrides are written under that attribute, so they apply to that module's pages and
to nothing else. The theme is the visitor's and cannot be overridden per module.

### From the command line

```bash
npm run modunexo -- settings list                                  # the platform appearance
npm run modunexo -- settings set appearance.accentHue 140
npm run modunexo -- settings list --module my-module               # declared settings and the module's appearance
npm run modunexo -- settings set report.title "Weekly" --module my-module
npm run modunexo -- settings set api.token --module my-module      # the value is read from standard input
npm run modunexo -- settings unset report.title --module my-module
npm run modunexo -- settings set appearance.accentHue 20 --module my-module
```

Platform appearance needs no master key; anything that touches a module's settings does, because a secret may be
among them. A secret given as an argument is refused (exit code `2`): it would show up in the process list and in
the shell history. Changes are recorded in `core.settings_events` (who, which key, set or unset, when) and never
hold a value. Uninstalling a module with `--purge` deletes its settings and its appearance override; `--keep`
leaves them, and the audit trail outlives both.

## Permissions and trusted proxies

### Permissions

A module declares the permissions it has under `permissions` (`key`, `label`) and ties them to what they protect:

```ts
permissions: [{ key: "reports.read", label: "Read reports" }],
nav: [{ label: "Reports", href: "/reports", permission: "reports.read" }],
pages: [
  { path: "/reports/export", entry: "./web/export.ts", kind: "route", permission: "reports.read" },
],
```

- A page's own `permission` covers that route, dynamic segments included (`/reports/[id]`, `/files/[...path]`).
- A navigation entry's `permission` covers its `href` **and everything below it**.
- Both apply to pages and to HTTP route handlers, and when several cover a path the visitor must hold all of them.
- The key must be one the same manifest declares; anything else is a manifest error naming the page.

The gate (`src/proxy.ts`) enforces this on every request, after the sign-in and local-only checks: a visitor who
does not hold a permission gets `403 Forbidden`, and one without a session is sent to sign in first (a module route
is not under `/api`, so it redirects instead of answering `401`). The local operator (sign-in disabled), an `admin` and an
`operator` hold every module permission; any other role holds none, so a protected path fails closed for it. There is
no per-permission grant yet: the operator role is "all of the modules, none of the platform". What only an
administrator may do (apps, settings, identity) is not a module permission; those routes check the role themselves.
A module should still not trust the URL alone for anything sensitive it computes.

### Trusted proxies

Behind a reverse proxy the shell sees the proxy's address on the connection, so by default every visitor shares one
sign-in limit and one person mistyping a password can lock the others out. List the proxies you control on the
Settings screen (Security) or with the CLI:

```bash
npm run modunexo -- settings set security.trustedProxies "10.0.0.2, 192.168.1.0/24"
npm run modunexo -- settings get security.trustedProxies
npm run modunexo -- settings unset security.trustedProxies
```

Entries are addresses or CIDR ranges, up to 50, with a prefix of /8 or longer: a list of proxies is not a place for
half the internet, so `0.0.0.0/0`, `0.0.0.0/1` and `::/1` are refused. When a request's connection comes from one of them, the sign-in limiter counts the nearest
address in `x-forwarded-for`, reading from the right, that is not itself a trusted proxy; each proxy appends the
address it received the request from, so a client that writes the start of the header is not believed. An entry
that cannot be read ends the walk at the proxy's own address, so made-up strings never become new identities. A
request from a connection that is not trusted never has its forwarded headers believed.

This changes only which client the limiter counts. What counts as local while sign-in is off still looks at
every address a request carries, so a setting cannot loosen it.

## Module packages

A module travels as one gzip tarball, like `npm pack` makes: a single top-level folder that holds `package.json`,
`manifest.ts`, `manifest.json`, the migrations folder, the web sources and, if it has them, hooks. `manifest.json` is
the same manifest written as data, so the platform can read what a package is without running any of it.

```bash
npm run modunexo -- modules pack ../reports-src --out reports-1.0.0.tgz   # on the author's machine
npm run modunexo -- modules add reports-1.0.0.tgz --sha256 <hex>          # on the platform
```

**`modules pack <folder> [--out <file>]`** evaluates the folder's `manifest.ts` (the author's own code, on the
author's machine - the only place a manifest is ever executed), writes `manifest.json` into the archive, checks the
result against this platform exactly as intake will, and prints the archive's size and SHA-256. Nothing is written
when it is not valid, and the folder is never modified. `node_modules`, `.git`, `.next`, `.env*`, other `.tgz` files
and `.DS_Store` are left out; a symbolic link is refused. The same folder always gives the same bytes. Without
`--out` the file is `<id>-<version>.tgz` in the current folder.

**`modules add <archive> [--sha256 <hex>] [--data-dir <path>] [--json]`** brings an archive in and prints a review:
what the module is, its pages, nav entries, permissions, settings, migrations, whether it has hooks, what it depends
on, the libraries it uses and the npm scripts it declares. **Nothing is installed.** The archive is copied into
`var/packages/<sha256>.tgz` while it is hashed, unpacked into `var/staging/<sha256>/` and read as data; no file of the
package is imported, required, executed or built, and its npm scripts never run. Every attempt, accepted or refused,
is recorded in `core.module_packages` with the SHA-256, the module and version when they could be read, the problems
and who did it. Adding the same archive again reuses the staged copy (and is recorded again). Exit codes: `0` staged, `3` refused (every problem is
listed, and nothing of the archive is kept), `1` environment error such as a missing file, `2` usage error.

What the platform refuses, so a package cannot choose where it writes or what it brings along:

- **The archive.** Absolute paths, `..`, links, devices and FIFOs, a second top-level folder, paths that differ only
  by case, `node_modules` and `.git`; more than 50 MB compressed, 200 MB unpacked, 5,000 entries or 255 characters
  in a path.
- **The checksum.** The platform computes the SHA-256 itself; with `--sha256` it must equal the one the publisher
  gave. Without it the hash is only recorded, so give it whenever you have one from a channel other than the archive.
- **The package.** A name in the platform's own `@modunexo` scope or one that collides with an installed package; a
  `package.json` version that differs from the manifest's; a manifest that does not validate; entries, hooks or
  migrations that are missing or point outside the package; pages under a path the shell reserves; a `platform` range
  this platform does not satisfy.
- **Dependencies.** A module cannot bring npm packages. Every dependency must already be installed in the platform and
  satisfy the declared range; links, URLs, tags and bundled dependencies are refused. Adding a library is a decision
  taken on the platform, on purpose, not something a package does.

Installing a module is code execution with database access: its migrations run as SQL, and its hooks and pages run
inside the platform. Review what `modules add` prints, and install only what you trust. Installing from a staged
package is `modules apply`, below.

### Installing a staged package

```bash
npm run modunexo -- modules apply <sha256>     # the SHA-256 that `modules add` printed
```

`modules apply` installs a new module or upgrades the installed module of the same id to the package's version
(the version must be greater). It takes minutes, because it builds the web app, **while the server keeps serving the
current build**, and prints each step:

1. **Preflight.** The package must have been staged, its tree must still be there and it is validated again against
   the platform as it is now. Anything wrong is refused (exit `3`) before a file is touched.
2. **Place.** The staged tree is copied to `modules/<id>/` and `node_modules/<package name>` is made a relative
   symlink to it, which is what a workspace install does; no package manager runs. An upgrade moves the folder it
   replaces to `var/previous/<id>-<version>/`.
3. **Verify.** The `manifest.ts` that is about to run (it is code) is loaded and must equal the `manifest.json`
   that was reviewed. A package that shows one manifest and runs another is refused and undone.
4. **Build.** The web app is registered with the module and built with `next build` into a directory of its own
   (`apps/web/.next-<id>`), next to the one that is serving, which is not touched. The new build starts from nothing (no
   cache is shared with another build). This runs **before** the database is touched, so a build that fails changes nothing
   in it, and its directory is simply removed.
5. **Lifecycle.** The module's migrations and hooks run through the same lifecycle as `modules install` or
   `modules upgrade` (dependency, platform and version rules included).
6. **Switch and restart.** Only now is the new directory recorded as the live one (`var/run/web.dist`), and the running
   server is asked to restart: the restart is the switch, and it serves the new directory.

If any step fails, the files, the link, the new build's directory and the registration are put back and the run ends
`rolled_back`; the build that was serving was never touched and keeps serving. One thing cannot be undone: if the lifecycle fails after some of
its migrations applied, those stay (the lifecycle's own rule) and a retry continues from there; the run says so.
A stop signal (Ctrl-C) during the build aborts it and rolls back like any failure. A run that is killed outright
(power loss, `kill -9`) leaves a journal in `var/run/apply.journal.json`; the next `modules apply` recovers first:
it puts the files, link and registration back and removes the half build's directory, or keeps the result and puts its
build in service if the database step had completed, and says so.
Every run is a row in `core.module_operations` (module, version, package SHA-256, kind, status, the step it is at,
detail, actor, times); only one runs at a time, and a run whose process died is closed as interrupted by the next
start.

**Restart contract.** `npm run web:start` now runs the server under a small supervisor that records its pid in
`var/run/web.pid` and restarts the server on `SIGUSR2`, and only then: a server that crashes or refuses to start
ends the launcher with its exit code, as before. `modules apply` signals that pid after checking that the process
is the launcher (its command line), so a stale file can never make it signal something else. With no server
running it says so and nothing is signalled; start it with `npm run web:start`. `web:dev` is not supervised. A server that ignores the stop request is killed after 15 seconds so a restart
cannot hang; and only a process whose command line is `apps/web/scripts/run.ts start` is ever signalled.

**No downtime while a change is built.** Every build starts from an empty directory (the cache is not shared with another
build, because sharing it corrupted builds), so each install, upgrade, enable, disable or uninstall pays a full build; on
this class of machine that is minutes. The server keeps answering for all of it, because the build is made beside the
serving one. The only gap is the restart that puts the new build in service: the old server stops (up to 5 s to finish
what it is doing) and the new one starts on the same port, so for some seconds requests are refused. A webhook sender
that retries, or a browser that reloads, will not notice more than that; it is not a restart with no gap at all (that
would need a proxy in front, which the platform does not have).

- **Which directory is live.** `var/run/web.dist` holds its name (`.next` or `.next-<letters and digits>`). A missing,
  empty or invalid record, or a directory that is gone or has no `BUILD_ID`, means `.next`: a deployment that never
  changed a module, or a container recreated from its image (the builds beside `.next` live in the container, not in a
  volume, so after a recreation the image's `.next` is served, as it always was). `MODUNEXO_DIST_DIR` is what
  `next.config` reads the directory from; the launcher sets it on every start of the server, so a restart serves the
  recorded one. `npm run web:build` by hand builds `.next` (or `MODUNEXO_DIST_DIR`) and records it.
- **Disk.** A build directory is about 150 MB. The live one and the one being built exist together; the one a switch
  replaced stays until the next run or the next start of the server, at least a minute later (the old server may still be
  draining), and is then removed. Only `.next` and names the platform generates (`.next-` and 8 to 16 lowercase letters or digits)
  are ever removed: a folder of yours called `.next-backup` is left alone. A directory a running install names in its journal is never
  removed, and recovery never removes the build that is serving.
- **Not covered.** Between the database step and the restart the old build serves against the new schema, for as long
  as the restart takes to be requested (seconds). Running the end-to-end tests builds in the repository's own
  `apps/web`, so do not run them while a server you care about serves from that folder.

Installing is code execution with database access: the module's hooks run inside the platform and its pages are
compiled into the web app. `modules pack` evaluates the author's `manifest.ts`, so it runs where `@modunexo/sdk` can
be resolved from the module folder (a project with the SDK installed). `MODUNEXO_DATA_DIR` moves `var/`. The pipeline is Linux-only: it uses `/proc/<pid>/cmdline` to recognise the launcher; elsewhere a restart is reported as not requested and the server
must be restarted by hand.

## Menu rule: one concern at a time

Owner rule (2026-10-17): a screen never stacks every option. A screen with more than one concern shows one at a time
behind tabs (`apps/web/src/components/ui/tabs.tsx`, the tab is kept in the address as `#id`, arrow keys move between
tabs), and anything occasional (adding an app, resetting the identity) opens on demand instead of sitting on the
page. Settings has the tabs Profile, Appearance, Security and Modules; Apps has Apps and History. New screens and
module pages follow the same rule.

## Operations

### Health

`GET /api/health` answers `200 {"status":"ok","database":"ok"}` when the database answers and
`503 {"status":"degraded","database":"unreachable"}` when it does not (or does not answer within 2 s). It needs no
session, so a load balancer or an orchestrator can probe it, and it says nothing about why it failed: the reason is in
the log. With sign-in disabled it is served to the local network only, like every other path. If the database is down
the access gate cannot read the sign-in mode, so it answers the probe itself with the same `503` body.

### Logs

The web app writes one line per event to standard output (errors and warnings to standard error). In production, or
with `LOG_FORMAT=json`, a line is a JSON object a log collector can parse:

```json
{"ts":"2026-10-18T12:52:55.874Z","level":"warn","event":"access.refused","detail":"refused GET /api/health: ..."}
```

Otherwise it is a readable `ts level event key=value` line (`LOG_FORMAT=text` forces it). A field named like a secret
(password, token, cookie, authorization, key, session) is written as `[redacted]`, an error is reduced to its name and
message, and a long value is cut, so a log can be shipped without scrubbing. Modules can use the same logger:
`import { log } from "@modunexo/core/log"`.

### Backup and restore

```sh
scripts/backup.sh                       # writes backups/modunexo-backup-<UTC time>/
scripts/restore.sh backups/modunexo-backup-20261018T120000Z --database-url postgres://...
```

A backup folder holds `database.dump` (PostgreSQL custom format), `modules.tar.gz` (installed modules, without
`node_modules` or `.next`), `packages.tar.gz` (received packages), `files.tar.gz` (the files modules stored), `BACKUP_INFO` and `SHA256SUMS`. It is readable by its
owner only: the dump contains every password hash and every encrypted secret. Options: `--out`, `--database-url`
(default `DATABASE_URL`), `--modules-dir`, `--data-dir`. The scripts use the PostgreSQL client tools from the `PATH` or,
if they are not installed, run them inside the compose `db` service.

**The master key is not in the backup, on purpose.** Stored secrets are encrypted with `MODUNEXO_MASTER_KEY`; keep it (and
your `.env`) somewhere else, such as a password manager. A restore without it works, but the stored secrets have to be
typed again.

The files are read after the database, so a file stored in between has bytes without a row (the worker removes those after a
day); stop the web app and the worker first if the backup must match to the second. A backup made before modules could store
files has no `files.tar.gz` and restores as before.

Restore never overwrites: it checks `SHA256SUMS` first and refuses a database that already has tables or folders that
already hold modules, packages or files, changing nothing. Create an empty database, restore, copy your `.env` with the same
master key, then `npm install && npm run registry:generate && npm run web:build`. Test a restore on a scratch database
before you need one, and copy the backup folders off the machine.

### Container and CI

```sh
export MODUNEXO_MASTER_KEY="$(openssl rand -base64 48)"   # keep it; see Backup and restore
docker compose --profile app up -d --build               # db + web on 127.0.0.1:3000
docker compose exec web npm run modunexo -- admin create --email you@example.com --name "Your Name"
```

The `web` service is behind the `app` profile, so the development flow (`docker compose up -d db`) is unchanged. The
image runs as a non-root user, applies the migrations on every start, and has a health check on `/api/health`.
A `worker` service (same profile, same image) runs the background jobs; restart it after installing or upgrading a
module (`docker compose restart worker`). Installed modules and received packages live in the `modunexo-modules` and `modunexo-data` volumes (back them up with
`scripts/backup.sh --modules-dir ... --data-dir ...`, or copy the volumes). Set `WEB_PUBLIC_URL` to the public https
origin when the app sits behind a TLS proxy. The image keeps the dev dependencies on purpose: installing a module
rebuilds the web app inside the container.

`.github/workflows/ci.yml` installs with `npm ci`, type-checks and runs the whole suite against a Postgres service on
every push and pull request.

## Hardening

- **Headers.** Every response carries `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`,
  `Permissions-Policy` and a content policy that forbids framing, plugins, a changed `<base>` and foreign form
  targets (`apps/web/src/server/security-headers.ts`). It has no `script-src` on purpose: the app has inline scripts.
  `Strict-Transport-Security` is sent only when `WEB_PUBLIC_URL` is https at build time.
- **Build environment.** `next build` runs with an allowlist of variables (`PATH`, `HOME`, locale, `NEXT_*`,
  `NODE_OPTIONS`, `WEB_PUBLIC_URL`, ...), never with `MODUNEXO_MASTER_KEY` or a database URL.
- **Cookies.** Settings > Security warns when sign-in cookies are not `Secure` because `WEB_PUBLIC_URL` is not https.
- **Installing is a trust decision.** A module runs with full access to the platform and its database. The Apps
  screen asks for an explicit acknowledgement and the API refuses `POST /api/apps/operations` unless the body is
  `{ sha256, acknowledge: true }`. The SHA-256 proves the file did not change, not who made it.

## The Apps screen

`/apps` has two tabs, **Apps** (the installed modules, the default) and **History**, so the page stays quiet. The
**Add app** button opens the manual upload on demand and closes it once a run starts. An administrator (or the local
operator while sign-in is off) sees that flow: upload the archive and, if the publisher gave one, its SHA-256; read
the review (what `modules add` prints); confirm; and follow the run. A non-administrator sees the list only.

- **Upload** does what `modules add` does and installs nothing. **Confirm** starts `modules apply` as a process of
  its own (it survives the server restart it causes), recorded as the signed-in user, and answers at once. The
  page polls the run and keeps polling across the restart. Only one run at a time: a second confirmation is
  refused while one is alive.
- **History** lists the runs (`core.module_operations`) and every package received, accepted or refused, with its
  problems.
- **Apps** lists each installed module with Enable, Disable and Uninstall. Each one rebuilds the web app for the
  new state (the build embeds only enabled modules), then runs the lifecycle and restarts the server, with the
  guarantees of an install: the rules of the lifecycle are checked first, a build that fails changes nothing in
  the database, a failed lifecycle puts the previous build back, and a killed run is recovered by the next one.
  Uninstall asks what happens to the data and has no default: *keep* leaves the schema and its migration history,
  *delete* drops them and asks you to type the module id.

The API behind it, administrator-only and same-origin for writes, like the settings API:

| Request | Does |
| --- | --- |
| `POST /api/apps/packages` | the body is the archive (raw bytes, up to 50 MB, counted as it streams); optional header `x-expected-sha256`. `200` staged with the review, `422` refused with every problem, `413` too large |
| `POST /api/apps/operations` `{ "sha256": "<hex>" }` | starts the install or upgrade of a staged package. `202` started, `404` not staged, `409` a run is alive |
| `POST /api/apps/modules/<id>` `{ "action": "enable" \| "disable" \| "uninstall", "mode": "keep" \| "purge" }` | starts a change of state with a rebuild; `mode` is required for uninstall and for nothing else. `202` started, `422` refused by the lifecycle (with its reason), `409` a run is alive |
| `GET /api/apps` | recent runs, received packages and the run in progress |

The process the screen starts is fixed (the repository's CLI, the SHA-256 and a plain actor name as its only
arguments, never through a shell); its output goes to `var/logs/apply-*.log`.

### Changing a module's state with a rebuild

`npm run modules -- enable|disable|uninstall <id>` keeps doing what it did: it changes the database and prints the
reminder to regenerate and rebuild by hand. Add `--rebuild` (optionally `--actor <name>` and `--data-dir <path>`)
and the same change runs through the pipeline: the registry for the state after the change is built into the web
app first, then the lifecycle runs, then the server is asked to restart. The Apps screen starts exactly that
command. Uninstall still needs `--keep` or `--purge`.

## License

Copyright (C) 2026 Eduardo Pedraza. The platform (`apps/web`, `packages/core`) is licensed under the
[GNU AGPL-3.0](LICENSE) with a **module exception**, and the module SDK (`packages/sdk`) under the
[MPL-2.0](packages/sdk/LICENSE). In short: improvements to the platform must be shared with whoever uses your
modified version, while **a module you write is yours** and can have any license, proprietary included. The details,
the exception text and the third-party notices are in [LICENSING.md](LICENSING.md); to contribute, read
[CONTRIBUTING.md](CONTRIBUTING.md).
