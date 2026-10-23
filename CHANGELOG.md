# Changelog

All notable changes to the platform. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
version follows [Semantic Versioning](https://semver.org/). The platform has one version (`CORE_VERSION`, written in the
root, `packages/core` and `apps/web`); the SDK keeps its own (`SDK_VERSION`), the number a module's `platform` range is
checked against, and it changes only when the contract with modules changes. See "Versioning" in the README.

## [Unreleased]

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
