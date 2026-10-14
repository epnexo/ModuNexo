# Handoff: where the shell stands (2026-10-14)

The owner paused the plan to build the other modules (ai-usage, documents, marketing) to polish the shell first.
This file is what a new session needs; the per-feature detail is in `odd/tasks/*.md` (source of truth) and the
Engram topics `odd/<feature>/tasks`.

## State

- Repo `CRM Module`, no git remote. Branches are stacked, oldest first, each a delivered and reviewed feature:
  `feat/shell-core-base` -> `feat/shell-ui-auth` -> `feat/shell-settings-appearance` -> `feat/shell-hardening` ->
  `feat/module-intake` -> `feat/module-install` -> `feat/apps-screen` -> `feat/apps-lifecycle` (head, 98dc3e6).
  Work continues from the head; chain strategy for PRs was never chosen (no remote).
- Suite: `TEST_DATABASE_URL=postgres://epnexo:epnexo@127.0.0.1:5436/epnexo_test` exported and `DATABASE_URL`
  unset, `npm test` (868 tests, about 8 minutes; the two end-to-end files take a lock and build for real),
  `npm run typecheck`.
- Services are DOWN: the web server is stopped; Postgres container `epnexo-db` (127.0.0.1:5436) is the project's
  and was left running.
- Project database: migrated through 0008; sign-in is DISABLED (`npm run epnexo -- auth status`), there is no
  administrator yet; module `hello` 1.1.0 is installed and enabled (the owner tried the Apps screen with the demo
  packages in `var/`, which git ignores). Its generated route `apps/web/src/app/(shell)/hello/` shows as untracked.
- Preview: `npm run web:build` then `npm run web:start` (127.0.0.1:3000); the Pi firewall blocks the LAN, so use an
  SSH tunnel: `ssh -L 3000:127.0.0.1:3000 <user>@<host>`.

## Polish backlog (found, not done)

Owner-visible:
1. The owner said "hay cosas para mejorar" and did not list them yet: start the next session by asking for that list.
2. Apps screen: uploading needs the file on the browser's machine (scp from the Pi); a disabled module is listed by
   its id, not its name (names come from the generated list, which has only enabled modules); a refusal that
   arrives after the 4 s settle time looks like "started" with no run row; the page does not follow the server
   restart smoothly.
3. While a build runs (minutes, always cold now) the running server's pages fail. Idea: build in a separate dist
   directory and swap; blocked by Next baking `distDir` into its manifests, needs an experiment.
4. Generated module routes under `src/app/(shell)/<module>/` appear as untracked files in git. Idea: generate
   them under a dedicated, git-ignored route group.
5. Better Auth logs "Base URL is not set" when no `WEB_PUBLIC_URL`; only matters behind a domain.
6. No scaffold or authoring guide for modules yet (stage C): `modules pack` needs `@epnexo/sdk` resolvable from the
   module folder.

Engineering:
7. `--rebuild` and `apply` have no `--web-root` option: they always act on this repository's `apps/web`
   (a verifier ran one by mistake). The CLI tests also run against the real web folder; give them a scratch root.
8. Recovery (`recoverInterrupted`) must keep acting only on a journal; keep that test.
9. Linux only (`/proc` to recognise the launcher). A restart queued during a restart spawns a child that is
   stopped at once (harmless).
10. Carried over: `db:migrate` warns on unreadable history; orphaned module rows have no cleanup path; no
    users-and-roles feature (module permissions only reach administrators); `impeccable` PRODUCT.md and
    DESIGN.md were never created; `epnexo` dev DB and the other Postgres servers on this machine are not ours.

## Things learned the hard way

- The intermittent build failures (`ENOENT ..._buildManifest.js.tmp`, `TS6053`) had two causes: a build cache
  shared between the kept and the new `.next` (removed: every build starts clean) and a recovery that treated a
  lone `.next.rollback` as an interrupted run (now: only a journal counts). Diagnose with a recursive watcher
  plus process snapshots over full-suite runs, not by reading.
- The web bundle must import the core through `@epnexo/core/apps`; the `install` barrel pulls `build.ts`, which
  resolves `next` at run time and breaks Turbopack tracing.
- `apps/web/scripts/serve.ts` runs under Node's strip-only TypeScript: no parameter properties or enums in its
  import chain.
- A long-lived `next-server` of another project (parent `run-next.mjs`) disappeared right after a verifier's real
  build in this repo; cause not established, not restarted.

## How reviews were run

`odd/tools/review_drive.py <repo> "<status command>"` drives one native review transaction with the owner's
standing consent per work unit. Get the status command from
`gentle-ai review status --cwd . --contract gentle-ai.review-integration/v2 --agent claude-code --next-transition --base-ref <last reviewed boundary> --committed-only --lenses risk,resilience,reliability --lenses-reason "..."`.
Last reviewed boundary: `b2bdaaf`..`98dc3e6` approved and acknowledged.
