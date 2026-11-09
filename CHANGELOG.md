# Changelog

All notable changes to the platform. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
version follows [Semantic Versioning](https://semver.org/). The platform has one version (`CORE_VERSION`, written in the
root, `packages/core` and `apps/web`); the SDK keeps its own (`SDK_VERSION`), the number a module's `platform` range is
checked against, and it changes only when the contract with modules changes. See "Versioning" in the README.

## [Unreleased]

### Added

- The sidebar can be collapsed to a rail of icons and opened again, with the button in the top bar or the `[` key (not while
  typing in a field). The rail is 64 px wide with 44 px targets. The choice is a cookie, so the server draws the right sidebar on the next page and nothing jumps. The
  names stay as each link's title and accessible name. Groups open and close with an animated height and a turning chevron.
  Motion shows a state change, lasts 150-260 ms, moves transform, opacity and one width, and is off for anyone who asked for
  less motion.

- Settings has one search box for every setting: type part of a label, its help text or a module's name and go straight to
  it. The index is built from what the modules declare, so it holds labels and links, never a value. The module list marks the
  modules that still have a required setting to fill in with "Needs setup". The tabs underline slides to the current tab.

### Changed

- The page area is wider (up to `96rem` instead of `64rem`) and a little tighter at the top, so tables and forms use the
  space they were losing. With the sidebar collapsed the page grows again (`120rem`, `96rem` with it open), so hiding it gives the content the room. The layout of the shell (Dashboard, module groups, Admin at the bottom) is unchanged.
- Settings, Modules tab: pick a module from a searchable list and see only its settings and API access, instead of every
  module stacked on one page. The choice is in the address (`/settings?module=<id>#modules`), so it survives a reload and
  can be shared. The server describes and renders only that module, so the page no longer grows with the number of
  installed modules. An id that is not an enabled module is never described; the first enabled module is shown instead.
  Administrator-only access to the page is unchanged.

## [0.4.0] - 2026-11-08
## [0.3.3] - 2026-11-08
### Fixed

- Upgrading or uninstalling a module no longer fails with `EXDEV: cross-device link not permitted` when the modules folder
  and the data folder are separate volumes, as in a container deployment. The installer moves the replaced or removed
  folder by copying it when a plain rename is refused, and a copy that fails leaves the original untouched.
- The Docker image no longer breaks the build with routes generated on the host, and a container started against a
  database with installed modules now links, registers and builds them on its own (`scripts/docker-entrypoint.sh`)
  instead of listing them as orphaned. `stack:up` seeds missing module packages into the volume; `WEB_PORT` sets the host
  port.

### Added

- Settings > Modules: an **API access** block under every module that declares scopes. An administrator sees the
  module's endpoints and its service tokens, creates a token per computer or person, copies it (shown once), regenerates
  it (a new token with the same name, scopes and life, the old one revoked in the same transaction) or revokes it. The
  address shown can be changed there. New: `TokenService.regenerate`, `find` and `tokenState`, `@modunexo/core/api-access`,
  and the `/api/settings/modules/<id>/tokens` and `/api/settings/api-address` routes.

- Settings > MCP: a four-step screen to connect Claude Code to the platform (where it runs, look only or look and change,
  one command to copy, how to check it), with the tools folded below. The commands follow the `claude mcp add` syntax, with
  an option between `--env` and the server name.
- `modunexo mcp`: an MCP server in the core, over stdio, so Claude Code (or any MCP client) can validate and operate the
  platform through the CLI. Read tools plus a `validate` report by default; enable or disable a module, queue, retry or
  cancel a job and publish an event only with `MODUNEXO_MCP_WRITE=1`. Passwords, secrets, tokens, installs and purges are
  never offered. No new dependency.
- Menu groups. An administrator creates, renames, reorders and deletes the titled blocks of the sidebar from a new **Groups**
  screen, and chooses the group of each installed module; the choice shows without a rebuild. A module with no assigned group
  keeps the group its manifest declares in `nav.group`. A group can also be chosen when installing: a selector on the Apps
  screen, an optional `groupId` in `POST /api/apps/operations` and `modules apply <sha256> --group <id>`. New migration
  `0014_module_groups.sql` (a table, and a nullable `group_id` on `core.modules`; existing modules are unchanged).
- Each titled block of the sidebar opens and closes like Admin. It starts open, stays open while the current page is inside it,
  and what a person closed is remembered in their browser.

### Fixed

- Next.js is updated from 16.4.0 to 16.4.3. 16.4.0 carries a known security advisory, and `next build` aborted the first time it was run
  after each change with a `SecurityFatalError` (a second run passed). With 16.4.3 the build runs through the first time and
  `npm audit` reports no vulnerabilities.
- The dashboard no longer alerts about an install or upgrade that failed and was retried with success, or that was followed
  by an uninstall: a failure counts only while it is the last operation of its module.

### Security

- The statements a module declares for the dashboard now run as a role that can read that module's schema and nothing else, so
  `select … from core.settings` or from another module's schema is refused by the database. It is a second line of defense, not
  isolation: a statement crafted to switch role from inside can still get out (see the README). The platform creates the role
  (`mnx_ro_<schema>`, no login) on first use; the database user needs `CREATEROLE` for that, and a card is "not available"
  without it. Migrations and a module's own code are unchanged and still run with the platform's credentials.

## [0.3.0] - 2026-10-23

### Added

- The dashboard replaces Home at `/`: alerts that need attention, the figures modules report, and, for an administrator, the
  platform's own alerts (stopped jobs, failed installs, unset required settings), totals and recent activity.
- Modules may declare a `dashboard` in the manifest: stats and alerts, each a `select` run `READ ONLY` in the module's schema
  with a time limit and behind an optional permission. It is optional; `modules pack` and `modules add` warn when it is missing.
  The SDK goes to `0.1.1` for it; an older platform refuses a manifest that declares it as an unknown field.
- The package review shows the dashboard (`review.dashboard`, a row in `modules add` and on the Apps screen).
- The version of the platform is shown in the footer of every screen of the shell, not only on Status.
- `@modunexo/core` exports `runner`, `job-runtime` and `settings-service`, the pieces a module's own tests need.

### Changed

- The sidebar starts with the Dashboard, and Apps, Status and Settings moved into a collapsible Admin block at the bottom that
  only an administrator is given. Their addresses did not change.
- The platform ships no business module. The `inbox` module moved to its own repository, `modunexo-modules`, and is
  installed from a packed archive. `modules-src/` is no longer tracked.

## [0.2.0] - 2026-10-21

### Added

- Active modules (ADR-001, accepted): public routes with signature verification (`/hooks/<module-id>/`), service tokens
  with scopes (`/svc/<module-id>/`), background jobs run by a separate worker process, events and realtime (a transactional
  outbox, server-sent events with a cursor), stored files behind a storage adapter, and a language-model adapter
  (OpenAI-compatible, configured by the module's own settings).
- The Status screen (`/status`, administrators only): jobs, events, stored files and a connection test for each module that
  calls a model. It never shows a job's data, an event's payload, a file's name or a key.
- The `inbox` module (`modules-src/inbox/`): a signed webhook, conversations, replies delivered by a job, and a live page.
- `modunexo --version`, and the version on the Status screen.

### Changed

- Installing or changing a module no longer takes the site down: the new build is made beside the one that is serving, and
  the restart that follows is the switch. A failed build leaves the serving build untouched.
- `/status` is reserved for the shell: a module cannot declare a page there.

### Fixed

- A generated public route whose signature declared an `encoding` could not be built.

## [0.1.0] - 2026-10-12

### Added

- The first working platform: the module contract (`defineModule`, the manifest and its validation), the registry with
  dependency ordering, migrations per module schema, the module lifecycle, settings with encrypted secrets, sign-in and
  administrators, the command line, and packing and installing modules (`modules new`, `pack`, `add`, `apply`) with the
  Apps screen.
