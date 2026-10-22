# Changelog

All notable changes to the platform. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
version follows [Semantic Versioning](https://semver.org/). The platform has one version (`CORE_VERSION`, written in the
root, `packages/core` and `apps/web`); the SDK keeps its own (`SDK_VERSION`), the number a module's `platform` range is
checked against, and it changes only when the contract with modules changes. See "Versioning" in the README.

## [Unreleased]

### Added

- The version of the platform is shown in the footer of every screen of the shell, not only on Status.
- `@modunexo/core` exports `runner`, `job-runtime` and `settings-service`, the pieces a module's own tests need.

### Changed

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
