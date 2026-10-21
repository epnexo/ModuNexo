# Feature: install without downtime (ADR-001, open question 1)

Objective: installing, upgrading, enabling, disabling or uninstalling a module builds the new web app next to the one that is serving, so the running server keeps answering during the build; only the restart that puts the new build in service is a gap, and it is seconds, not minutes.
Branch: feat/install-without-downtime (from main c2d7b78). Delivery strategy: ask-on-risk; the owner wants only `main` on GitHub, so the branch stays local and is fast-forwarded into `main`; no push without the owner. Test runner: `npm test` (node:test via tsx), `npm run typecheck`.

## Specs

- S1. Build beside, not over: a module change (`modules apply`, `modules enable|disable|uninstall --rebuild`, the Apps screen)
  builds the web app into a directory of its own while the running server keeps serving the current one, untouched. Pages of
  the running server do not fail during the build. [decision]
- S2. Switch: only after the build AND the lifecycle step have succeeded does the platform record the new directory as the
  live one and ask the supervisor to restart; the restarted server serves the new directory. The restart is the only moment
  pages fail, and it takes seconds. [decision]
- S3. Failure leaves the live build alone: a failed build, a failed lifecycle step, a signal during the build, or a crash
  leaves the live directory and its record unchanged and removes the unfinished directory. Recovery from the journal does
  the same for every phase, and completes the switch when the lifecycle step had already finished. [decision]
- S4. Directories: the live directory is named by a record in the data directory (`run/web.dist`); a missing record, a name
  that is not `.next` or `.next-<suffix>` of letters and digits, or a directory without `BUILD_ID` means `.next` (a deployment
  that never changed a module, or a container that was recreated from the image). `next.config` takes its `distDir` from
  `MODUNEXO_DIST_DIR` (default `.next`). A directory that is neither the live one nor the one being built is removed when the
  next run starts and when the server starts, never while the server it belonged to may still be draining. [decision]
- S5. `npm run web:build` writes the record for the directory it built, so `web:start` serves what was just built. Docker
  and the README setup keep working with no new step. [decision]
- S6. Docs: README (the downtime paragraphs and the restart contract), the HANDOFF, and ADR-001 open question 1 answered.
- Not in this feature (follow-ups): a restart with no gap at all (a proxy or a socket handed to the new process); the window
  between the lifecycle step and the restart, in which the old build serves against the new schema; restarts on systems
  without `/proc`.

## Tasks

- [x] T0 experiment: Next 16 honours `distDir` from the environment for both `build` and `start`, a build in a second directory does not disturb a server running from `.next`. Route: inline. Evidence: L5.
- [x] T1 (S4) the directory record: names, read and write of `run/web.dist`, fallback to `.next`, removal of stray directories; `next.config` `distDir`. Route: inline. Commit: next commit (RED observed; 18 tests)
- [x] T2 (S1, S3) `buildWithRollback` builds into a new directory; commit and rollback; journal and recovery. Route: inline. Commit: next commit (RED observed; install suites 63/63)
- [x] T3 (S2, S5) `run.ts start` reads the record for each (re)start; `web:build` writes it; the supervisor passes the directory to the server. Route: inline. Commit: next commit (RED observed for the supervisor and the start preparation; 31 tests)
- [x] T4 (S1, S2, S3) apply and change integration; end-to-end: a real build while the server answers continuously. Route: inline. Commit: next commit (e2e 9/9; mutation check red)
- [ ] T5 (S6) docs, full suite, independent verifier. Route: inline then verifier.

## Log

- L1 (2026-10-21, user, verbatim): "resuelve primero la caída al instalar"
- L2: Route declaration: all tasks inline; no writer trigger (tasks share core, web scripts and tests). Mapping trigger fired once
  (explorer: apply/change/build/recover/journal, restart and supervisor, every `.next` reference, the tests, Docker, README).
  Risk: delivery and environment (item 5: the build, the restart and the recovery of an interrupted run), concurrency (item 4: a
  server draining while a new build exists) and data on disk (a directory removed at the wrong moment), so an independent
  verifier runs at the end.
- L3: Facts from the map. The cause: `buildWithRollback` renames `.next` to `.next.rollback` and creates an empty `.next` BEFORE
  `next build` (build.ts:113-115), so the running server has no `.next` for the whole build. Going live is a SIGUSR2 to the
  supervisor, which SIGTERMs the server (5 s grace, 15 s kill) and starts a new one on the same fixed port; nothing but
  build.ts and recover.ts names `.next`; `next.config.ts` sets no `distDir`; everything the web bundle needs from modules is
  generated into `apps/web/src/generated` and `src/app/(shell)/<module>` before the build and is bundled by it, so the running
  server does not read them. Not checked by the explorer: whether Turbopack leaves some module code external; T0 settles it.
- L4: Decisions taken without asking, per the standing instruction: build into a new directory per run and switch by a record
  (not by renaming `.next` over the live one, which would still pull the files from under a running server); keep the restart
  as it is, since it already costs seconds; a stray directory is removed at the start of the next run or server start,
  not at the switch, because the old server drains for up to 5 s and may still read its files.
- L5: T0 observed on Next 16.4.0 (Turbopack, production). (a) With `distDir` taken from `MODUNEXO_DIST_DIR`, `next build` wrote
  `.next-exp` and the server running from `.next` on :3000 answered 200 on all 12 polls made during the build. (b) A second server
  started with `MODUNEXO_DIST_DIR=.next-exp` served health and pages from it (the bake of `distDir` into the manifests is not a
  problem: nothing is renamed, both sides get the same variable). (c) The first attempt FAILED the build's type check: `tsconfig.json`
  includes `.next/types/**` by name, so a build into another directory type-checked the LIVE directory's generated types, which
  name pages that a change may have removed (an uninstall would fail its own build). A build needs a tsconfig whose `include`
  names only its own directory's types; with `typescript.tsconfigPath` pointing at it the build passed. (d) `start` does not need
  that file. (e) Each directory is about 150 MB, so live plus the one being built is the peak. `next build` also rewrites the
  git-ignored `next-env.d.ts` to point at the directory it built, which `next typegen` restores for `npm run typecheck`.
  Also seen: the e2e tests build in the repository's own `.next`, under whatever server runs from it; the :3000 dev server
  should be rebuilt after running them.
- L6: T1 additions found while writing the tests: the directory name becomes a folder name, so it is validated three times
  (`isDistName` in the record, the same rule in `next.config` where it throws on a bad `MODUNEXO_DIST_DIR`, and `writeDistTsconfig`);
  a record of `.next` must not ask for a `tsconfig.next.json` that does not exist; a stray directory is not removed for 60 s
  after the record was written (the replaced server may be draining); a link named like a build directory is removed, never followed.
- L7: T2 observed. `buildWithRollback` no longer moves `.next`: it builds into the directory the caller names (`newDistName()`, written
  into every journal), refuses to write over the live one, clears strays first (not within 60 s of a switch), type-checks with a
  tsconfig of its own, and goes live only at `commit()` (a record, refused if the directory has no BUILD_ID). Recovery of a journal
  that names a directory removes it when the lifecycle step had not completed, and puts it in service when it had (or says it is not
  a finished build and keeps what was serving); a journal with no directory (written by the old code) still restores `.next.rollback`.
  Four tests of mine were wrong, not the code (BUILD_ID text repeats between builds, the live build's own tsconfig is rightly kept,
  the serving build was read before the install that changes it, the serving log was not reset after the install helper).
- L8: T3 observed. The supervisor asks `prepare` before every start (the first and each restart) and merges its answer into the child's
  environment (a throwing `prepare` is logged and the server still starts). `prepareServerStart` picks the record's directory or `.next`
  and clears directories nobody serves, leaving alone the one a journal names (a restart in the middle of an install must not pull a
  build from under it) and everything for 60 s after a switch. `web:build` by hand writes its tsconfig, builds, and records the directory.
- L9: T4 observed on real builds (install e2e file, 9/9). A probe asked the server for a page every 100 ms for the whole run: install
  and upgrade had at least 100 requests during the build and every one was answered; the failing real build had no failed request
  at all (no restart, no switch); the only gap was the restart, under the 20 s the test allows. Directories did not pile up: after
  the upgrade only the build it replaced and the live one remained, and after the failed build only the live one. Mutation check
  (not committed): putting the old behaviour back (the serving build moved aside while the new one is made) made the first test fail
  on "the server answered every request while the build ran", so the probe can see the defect this feature removes. The unit-level
  red was observed earlier (install-build tests: the runner asserts the serving build is untouched while it runs).
  Documented in the README (the downtime paragraphs) and the HANDOFF; ADR-001 open question 1 now points here.
