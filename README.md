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
npm run epnexo -- modules pack <folder> [--out <file>]
npm run epnexo -- modules add <archive> [--sha256 <hex>] [--json]
npm run epnexo -- modules apply <sha256> [--json]
npm run epnexo -- modules enable|disable|uninstall <id> --rebuild   # the change plus the rebuild and restart
npm run db:migrate                        # the core only; reports installed modules that need "modules upgrade"
npm run registry:generate [-- --dry-run] [-- --out <dir>]
npm run epnexo -- admin create --email <email> --name <name>
npm run epnexo -- auth status | require | disable
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
balanced (only `[x]`, `[...x]` and `[[...x]]` exist), a path at or below a reserved shell path (`RESERVED_PATHS`: `/`, `/apps`, `/settings`, `/login`,
`/logout`, `/api`, `/_next`), and segments that cannot be a folder name. `--dry-run` prints the planned writes
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
npm run epnexo -- auth status     # sign-in: required | disabled
npm run epnexo -- auth disable
npm run epnexo -- auth require
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
`https://epnexo.example.com`: left unset the app serves plain HTTP on the local network and its session cookie works
there; set to an `https` origin the cookie becomes `Secure`. It must be a bare origin, with no path. `web:start` and `web:dev` refuse to start without `EPNEXO_MASTER_KEY` and say so in one
line. Installing, disabling or uninstalling a module changes the registry: run `web:build` and restart.

### The shell

Every page sits in the `(shell)` route group, whose layout draws the sidebar and the top bar. Generated module
routes are written into that same group (`src/app/(shell)/<path>`), so a module's pages get the shell without
knowing about it; only `/login` stands outside. The sidebar is the shell's own entries (Home, Apps, Settings) and
then the enabled modules' `nav` entries, grouped and ordered as their manifests declare. An entry that names a
`permission` is shown to the local operator and to an administrator only, and the gate enforces the same rule on
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
address from a forged one. The server therefore sets `x-epnexo-client-ip` from the connection on every request and
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
with `epnexo settings`. A module's server code reads its own settings with the SDK:

```ts
import { getSetting } from "@epnexo/sdk";

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

### Secrets

A `secret` is stored encrypted with AES-256-GCM under a key derived from `EPNEXO_MASTER_KEY`, bound to its module
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
- The logo or photo replaces `epnexo` in the sidebar, the mobile bar, the sign-in page and the page titles, and a
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
npm run epnexo -- settings list                                  # the platform appearance
npm run epnexo -- settings set appearance.accentHue 140
npm run epnexo -- settings list --module my-module               # declared settings and the module's appearance
npm run epnexo -- settings set report.title "Weekly" --module my-module
npm run epnexo -- settings set api.token --module my-module      # the value is read from standard input
npm run epnexo -- settings unset report.title --module my-module
npm run epnexo -- settings set appearance.accentHue 20 --module my-module
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
is not under `/api`, so it redirects instead of answering `401`). Today the local operator and an administrator hold
every permission and nobody else holds any, so a protected path is theirs alone. Granting a permission to another
user is a users-and-roles feature that does not exist yet; until then this fails closed. A module should still not
trust the URL alone for anything sensitive it computes.

### Trusted proxies

Behind a reverse proxy the shell sees the proxy's address on the connection, so by default every visitor shares one
sign-in limit and one person mistyping a password can lock the others out. List the proxies you control on the
Settings screen (Security) or with the CLI:

```bash
npm run epnexo -- settings set security.trustedProxies "10.0.0.2, 192.168.1.0/24"
npm run epnexo -- settings get security.trustedProxies
npm run epnexo -- settings unset security.trustedProxies
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
npm run epnexo -- modules pack ../reports-src --out reports-1.0.0.tgz   # on the author's machine
npm run epnexo -- modules add reports-1.0.0.tgz --sha256 <hex>          # on the platform
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
- **The package.** A name in the platform's own `@epnexo` scope or one that collides with an installed package; a
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
npm run epnexo -- modules apply <sha256>     # the SHA-256 that `modules add` printed
```

`modules apply` installs a new module or upgrades the installed module of the same id to the package's version
(the version must be greater). It takes minutes, because it builds the web app, and prints each step:

1. **Preflight.** The package must have been staged, its tree must still be there and it is validated again against
   the platform as it is now. Anything wrong is refused (exit `3`) before a file is touched.
2. **Place.** The staged tree is copied to `modules/<id>/` and `node_modules/<package name>` is made a relative
   symlink to it, which is what a workspace install does; no package manager runs. An upgrade moves the folder it
   replaces to `var/previous/<id>-<version>/`.
3. **Verify.** The `manifest.ts` that is about to run (it is code) is loaded and must equal the `manifest.json`
   that was reviewed. A package that shows one manifest and runs another is refused and undone.
4. **Build.** The web app is registered with the module and built with `next build`. The previous `.next` is kept
   aside, and the new build starts from a clean `.next` (no cache is shared with it). This runs **before** the database is
   touched, so a build that fails changes nothing in it.
5. **Lifecycle.** The module's migrations and hooks run through the same lifecycle as `modules install` or
   `modules upgrade` (dependency, platform and version rules included).
6. **Restart.** The running server is asked to restart so it serves the new build.

If any step fails, the files, the link, the build and the registration are put back and the run ends
`rolled_back`; the previous build keeps serving. One thing cannot be undone: if the lifecycle fails after some of
its migrations applied, those stay (the lifecycle's own rule) and a retry continues from there; the run says so.
A stop signal (Ctrl-C) during the build aborts it and rolls back like any failure. A run that is killed outright
(power loss, `kill -9`) leaves a journal in `var/run/apply.journal.json`; the next `modules apply` recovers first:
it puts the files, link, build and registration back, or keeps the result if the database step had completed, and
says so.
Every run is a row in `core.module_operations` (module, version, package SHA-256, kind, status, the step it is at,
detail, actor, times); only one runs at a time, and a run whose process died is closed as interrupted by the next
start.

**Restart contract.** `npm run web:start` now runs the server under a small supervisor that records its pid in
`var/run/web.pid` and restarts the server on `SIGUSR2`, and only then: a server that crashes or refuses to start
ends the launcher with its exit code, as before. `modules apply` signals that pid after checking that the process
is the launcher (its command line), so a stale file can never make it signal something else. With no server
running it says so and nothing is signalled; start it with `npm run web:start`. `web:dev` is not supervised. A server that ignores the stop request is killed after 15 seconds so a restart
cannot hang; and only a process whose command line is `apps/web/scripts/run.ts start` is ever signalled.

Things to know. Every build starts from an empty `.next` (the cache is not shared with the kept build, because
sharing it corrupted builds), so each install, upgrade, enable, disable or uninstall pays a full build; on this class
of machine that is minutes. While the build runs the server's `.next` has been moved aside, so pages that were not yet loaded
by the running server fail until the build finishes or is rolled back; do an install when that is acceptable.
Installing is code execution with database access: the module's hooks run inside the platform and its pages are
compiled into the web app. `modules pack` evaluates the author's `manifest.ts`, so it runs where `@epnexo/sdk` can
be resolved from the module folder (a project with the SDK installed). `EPNEXO_DATA_DIR` moves `var/`. The pipeline is Linux-only: it uses `/proc/<pid>/cmdline` to recognise the launcher; elsewhere a restart is reported as not requested and the server
must be restarted by hand.

## The Apps screen

`/apps` shows what the running build was generated with. An administrator (or the local operator while sign-in is
off) also sees the flow for adding a package: upload the archive and, if the publisher gave one, its SHA-256; read
the review (what `modules add` prints); confirm; and follow the run. A non-administrator sees the list only.

- **Upload** does what `modules add` does and installs nothing. **Confirm** starts `modules apply` as a process of
  its own (it survives the server restart it causes), recorded as the signed-in user, and answers at once. The
  page polls the run and keeps polling across the restart. Only one run at a time: a second confirmation is
  refused while one is alive.
- **History** lists the runs (`core.module_operations`) and every package received, accepted or refused, with its
  problems.
- **Installed modules** lists each module with Enable, Disable and Uninstall. Each one rebuilds the web app for the
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
