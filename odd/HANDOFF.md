# Handoff: where the platform stands (2026-10-21)

Modunexo (formerly "epnexo") is a module platform: a shell plus modules that are installed, enabled and, since ADR-001,
active participants of the runtime. This file is what a new session needs; the per-feature detail is in
`odd/tasks/*.md` (source of truth) and the Engram topics `odd/<feature>/tasks`.

## State

- Repo `CRM Module`, remote `git@github.com:epnexo/ModuNexo.git`. **Only `main` is published, by the owner's choice**: feature
  branches stay local, are fast-forwarded into `main`, and nothing is pushed without the owner saying so. `main` and
  `origin/main` were both at `2492f8e` when this was written. Every local `feat/*` branch is already contained in `main`
  (delete them whenever you like); history was rewritten once to remove a committed `.env.example`, so GitHub may still serve
  the old commit by hash.
- Layout: `packages/sdk` (what modules import), `packages/core` (database, lifecycle, jobs, events, files, llm, CLI),
  `apps/web` (Next.js plus a thin Node server), `modules/` (installed modules, git-ignored; only the demo `hello` is
  installed). Commits are conventional, in English, with no AI attribution.
- Suite: `unset DATABASE_URL; export TEST_DATABASE_URL=postgres://epnexo:epnexo@127.0.0.1:5436/epnexo_test; npm test`
  (1357 tests, about 20 minutes; the end-to-end file builds the web app for real and takes a lock). **Without
  `TEST_DATABASE_URL` the database tests skip silently and the run still looks green.** `npm run typecheck` as well.
- Services on this machine: Postgres container `epnexo-db` (127.0.0.1:5436) is the project's; `epnexo-platform-db`,
  `coolify-db` and the others are not ours. The dev database is migrated through 0013, sign-in is DISABLED
  (`npm run modunexo -- auth status`), there are no users yet, and `hello` 1.1.0 is enabled. The web app was last started with
  `npm run web:start` on 127.0.0.1:3000 after a `npm run web:build`. **No worker process runs**: jobs, event subscriptions and
  the hourly file sweep do nothing until `npm run modunexo -- worker` is started next to the web app.
- Preview from another machine: the Pi firewall blocked the LAN on 2026-10-14 (not re-checked); use an SSH tunnel,
  `ssh -L 3000:127.0.0.1:3000 <user>@<host>`.

## What is built (ADR-001, `docs/adr/001-active-modules.md`)

All six capabilities, each opt-in per module through its manifest, each with a feature document in `odd/tasks/`:

1. Public routes with signature (`/hooks/<module>/`): `public-routes.md`.
2. Service tokens with scopes (`/svc/<module>/`): `service-tokens.md`.
3. Background jobs run by a separate worker (Postgres queue): `background-jobs.md`.
4. Events and realtime (log in Postgres, jobs for subscribers, server-sent events with a cursor at `/api/events`): `events-realtime.md`.
5. Files behind a storage adapter (disk first; `GET /api/files/<module>/<id>`): `files-attachments.md`.
6. Chat model through an OpenAI-compatible adapter, configured by the module's own settings (`llm probe`): `llm-adapter.md`.

The README has a section for each ("Public routes", "Service tokens", "Background jobs", "Events and realtime", "Stored files",
"Language models") and the module skill (`.claude/skills/modunexo-module/SKILL.md`) has the rule for each.

## Backlog (found, not done)

Owner-visible:
1. The owner said "hay cosas para mejorar" on 2026-10-14 and never listed them: ask for that list.
2. Apps screen (from 2026-10-14, not re-checked): uploading needs the file on the browser's machine; a disabled module is
   listed by id; a refusal after the 4 s settle time looks like "started" with no run row; the page does not follow the
   restart smoothly.
3. Installing no longer takes the site down: a module change builds into `apps/web/.next-<id>` while the server keeps serving, and
   the restart that follows is the switch (seconds; `odd/tasks/install-without-downtime.md`). Left over: the gap of that
   restart (only a proxy in front would remove it); the seconds between the database step and the restart, when the old
   build serves against the new schema; in Docker the builds live in the container, not in a volume, so a recreated
   container serves the image's `.next` again.
4. Better Auth logs "Base URL is not set" without `WEB_PUBLIC_URL`; only matters behind a domain.
5. Nothing exercises the new capabilities from the screen yet: the only installed module (`hello`) uses none, so a module
   that uses events, files and a model is the natural next piece (the end-to-end fixture in
   `apps/web/test/e2e.integration.test.ts` shows one).

Engineering:
6. `--rebuild` and `apply` have no `--web-root` option: they always act on this repository's `apps/web`.
7. Linux only (`/proc` to recognise the launcher).
8. Users have two roles (`admin`, `operator`); only they hold module permissions. A real users-and-roles feature does not exist.
9. Left open by the verifiers (details in each feature's Log):
   - events: stopping the hub does not close open streams; permission and sign-in are checked when a stream opens, not
     while it stays open; a long publisher transaction makes new streams wait; a false `reset` when ids after a cursor were
     rolled back and earlier rows pruned; the subscriber-failure log has no rate limit.
   - files: `DiskStorage` checks a link only as the last part of a key, so someone who can already write the data directory
     could point `<root>/<module>` elsewhere; `backup.sh` aborts (a retry works) if a `.tmp` file vanishes while `tar` reads
     it; `/api/files/` with a trailing slash gets neither header rule; a 403 versus a 404 tells a signed-in viewer which
     modules store files.
   - llm: the key is scrubbed from errors but not from a successful reply; a `signal` that is not an `AbortSignal` raises a
     `TypeError`; `instanceof LlmError` is true for any subclass and survives an object spread.
10. Not built, on purpose: a React hook for the event stream, replay of events to a disabled module, an object-storage adapter,
    thumbnails and a virus-scan hook for files, quotas on a module's total, streaming / tools / embeddings / retries / a usage
    log for the model adapter, more than one provider per module.

## Things learned the hard way

- `cmd1 && cmd2` after a pipe (`... | tail`, `... | rg`) does not stop when the first command fails: check the exit code, or
  commit only after reading the summary line.
- A test that inserts rows with the database clock while the code under test uses a fake clock passes only until that day.
  Pass the fake clock into the insert (it bit two jobs tests).
- `next.config` `headers()` REPLACE a header the route sets itself: the download and the logo set
  `Content-Security-Policy: default-src 'none'; sandbox`, and the global policy hid it until `headerRules` (in
  `apps/web/src/server/security-headers.ts`) left those paths out of the global rule.
- The Next bundle can hold more than one copy of `@modunexo/sdk`. Services are shared through `Symbol.for(...)` on
  `globalThis`; a class made by one copy fails `instanceof` in another unless it carries a `Symbol.for` mark (`LlmError` does).
- `Readable.fromWeb` listens at once: a web stream that fails before anyone reads it raises an uncaught exception. Read
  request bodies through your own lazy reader.
- `Array.prototype.forEach` skips holes: validate lists with an indexed loop.
- `tsconfig.json` names `.next/types` by path, so `next build` into another directory type-checks the types of the LIVE build, which
  name pages a change may have removed (an uninstall would fail its own build). A build into `.next-<id>` therefore gets a tsconfig
  of its own (`writeDistTsconfig`, named from `typescript.tsconfigPath` in `next.config`).
- The end-to-end tests build in the repository's own `apps/web` (`.next` and `.next-*`); do not run them while a server you care
  about is serving from that folder, and rebuild it afterwards.
- An end-to-end run found three defects that every unit test had missed (header override, cross-copy `instanceof`, a purge
  path that skipped the bytes). Keep that file running for anything that crosses the bundle boundary.
- The harness refuses to read `.env*` files; never try. `bat` is not installed here; use the Read tool.
- The intermittent build failures of October (`ENOENT ..._buildManifest.js.tmp`, `TS6053`) had two causes, a build cache shared
  between the kept and the new `.next` (removed) and a recovery that treated a lone `.next.rollback` as an interrupted run (now
  only a journal counts).
- The web bundle must import the core through narrow entry points (`@modunexo/core/files`, `/llm`, `/events`, ...); the
  `install` barrel pulls `build.ts`, which resolves `next` at run time and breaks Turbopack tracing.
- `apps/web/scripts/serve.ts` runs under Node's strip-only TypeScript: no parameter properties or enums in its import chain.

## How work was run

ODD: a large task gets `odd/tasks/<feature>.md` (specs `S#` quoting the owner, tasks `T#`, a Log) and an Engram mirror,
tests are written red first, a feature that touches security or data ends with an independent verifier that probes in a scratch
copy, and every code change closes with a `Risk:` line. The native review (`gentle-ai review`) was NOT run for capabilities 1 to 6;
an independent verifier ran for each instead. `odd/tools/review_drive.py <repo> "<status command>"` drives one native review
transaction if the owner wants one. The commits an earlier native review covered were renamed by the history rewrite, so there
is no usable "last reviewed boundary": start from the commit before the work to review.
