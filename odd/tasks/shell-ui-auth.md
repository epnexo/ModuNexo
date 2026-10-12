# Shell UI and admin login (stage A2)

Objective: give the empty platform shell a web application with an administrator login, a
layout whose navigation comes from the generated module registry, and a home screen, all
working with zero modules installed.
Branch `feat/shell-ui-auth`, stacked on `feat/shell-core-base` (head `981c8a7`). Delivery
strategy `auto-chain`; chain strategy not chosen (the repository has no remote).
Test runner: `npm test` (`node:test` through `tsx`), `npm run typecheck`, and
`npm run build -w @epnexo/web` once the web app exists. Strict test-first.

## Specs

Quoted fragments are the owner's words. Everything else is the plan agreed in the session
and is marked as an assumption where the owner did not state it.

- **S1 Authentication library.** "si, arranque el shell con better auth". Sign-in is email
  and password through Better Auth, backed by the platform's Postgres pool.
  - Its tables are created by a core SQL migration, in the `core` schema, with the prefix
    `auth_`. Better Auth's own migrate command is never run against the database.
  - Public sign-up is disabled: the sign-up endpoint refuses.
  - Assumption: the Better Auth admin plugin is enabled so a user carries a `role`, and the
    only role the shell knows in this feature is `admin`, which holds every permission.
- **S2 First administrator.** Assumption: because nobody can sign up, the first
  administrator is created from the command line with `epnexo admin create --email <email>
  --name <name>`. The password is read from standard input (hidden prompt on a terminal),
  never from an argument. Creating a user whose email already exists is refused with exit
  code 3 and changes nothing. A password shorter than 12 characters is refused.
- **S3 Environment.** Agreed plan: environment variables only for infrastructure. This
  feature adds one, `EPNEXO_MASTER_KEY` (at least 32 characters). The Better Auth secret is
  derived from it and is not a separate variable. The web app refuses to start without it,
  with a message that names the variable. `WEB_HOST` and `WEB_PORT` choose where the web app
  listens (defaults `127.0.0.1` and `3000`).
- **S4 Guarded web application.** A Next.js application in `apps/web`. Every page except
  `/login` requires a valid session, checked against the database on the server; a visitor
  without one is redirected to `/login`. A signed-in visitor who opens `/login` is sent to
  `/`. Signing out ends the session and returns to `/login`. A wrong email or password shows
  one generic message that does not reveal which of the two was wrong. Repeated failed
  sign-ins are rate limited.
- **S5 Shell layout.** A sidebar built from the generated registry's navigation, grouped and
  ordered as the manifests declare and filtered by the signed-in user's permissions; a top
  bar with the signed-in user and a sign-out action; a home screen. With zero modules the
  sidebar shows only the shell's own entries (Home, Apps, Settings) and the home screen says
  that no modules are installed. `/apps` and `/settings` exist as placeholders that the next
  features (A4, A3) fill.
- **S6 Appearance.** Agreed plan: appearance by design tokens, no free CSS. Colors, radius
  and fonts are CSS variables in one tokens file; light and dark themes; restrained motion
  that respects `prefers-reduced-motion`. Assumption (the owner asked for a friendly,
  professional interface with motion and did not choose a toolkit): Tailwind CSS 4 with
  locally owned components in the shadcn style, icons from `lucide-react`, animation with
  `motion`.
- **S7 Core stays generic.** No file under `packages/` or `apps/` names a business module.
  `registry:generate` with zero modules produces a registry the web app builds against. The
  production build runs on the Raspberry Pi and its duration is recorded.
- **S8 Documentation.** The README explains the new variable, creating the administrator,
  and building and starting the web app.

- **S9 Sign-in can be switched off.** "se puede tener una opcion para desabilitar el login ya que como
  lo voy a manejar en mi red local casi no seria necesario tener login pero si se expone a internet
  tener la posibilidad de habilitarlo". Design decisions taken for it (assumptions, told to the owner):
  - Sign-in is required by default. `epnexo auth disable` switches it off, `epnexo auth require`
    switches it back on, `epnexo auth status` prints the mode. The mode is stored in the database, so
    the settings screen of the next feature can expose the same switch.
  - With sign-in off the shell serves local requests only: a request is refused (HTTP 403, with a
    message that says how to require sign-in) when any address it carries is not loopback or
    private, so an instance later exposed through a proxy or tunnel is closed, not open.
  - With sign-in off there is no session: the shell acts as a local operator who holds every
    permission, says so in the top bar, and `/login` redirects to `/`.
  - `auth require` is refused with exit code 3 while no administrator exists, so switching sign-in on
    cannot lock the owner out.

## Tasks

- [x] **T1** (S1, S2, S3) Auth foundation in `@epnexo/core`: master key, auth factory, core
  migration for the auth tables, `admin create` command, tests. Route: inline. Risk: item 2
  (authentication), independent verifier after the unit's own checks. Commit `5e5b061`.
- [x] **T2** (S3, S6, S7) Web app scaffold: Next.js, Tailwind tokens, light and dark themes,
  typecheck covering `.tsx`, scripts, build against the empty registry. Route: inline.
- [ ] **T6** (S9) Sign-in mode in `@epnexo/core`, done before T3: core settings table, mode read and
  write, `auth status | require | disable` commands, the local-request rule as a pure function.
  Route: inline. Risk: item 2.
- [ ] **T3** (S4, S9) Sign-in page, auth route handler, server-side guard that honours the sign-in
  mode, sign-out. The server must set `x-epnexo-client-ip` from the connection and strip any copy a
  client sent (the rate limiter keys only on it, see L9); how a Next.js route handler can read the
  connection address must be proven by a request against the built app, and a custom server wrapper
  is the fallback. Route: inline. Risk: item 2, independent verifier after T3 covering T6 and T3.
- [ ] **T4** (S5, S6) Shell layout: sidebar from the registry, top bar, home screen, Apps
  and Settings placeholders. Route: inline.
- [ ] **T5** (S7, S8) End-to-end smoke of the built app (sign-in, guard, sign-out), build
  time on the Pi, README. Route: inline.

Forecast: about 2,000 authored changed lines, above the 400-line review budget, so the
feature is a chain with one slice per task.

## Log

- **L1** (2026-10-13, owner, verbatim): "si, arranque el shell con better auth"
- **L2** (2026-10-13, owner, verbatim, the question that preceded L1): "ya cree el .env cual
  es mejor y mas robusto el shel o una libreria?" Answer given: the library, because the
  login is the security perimeter in front of module installation (code execution with
  database access); Auth.js is maintained by the Better Auth team, which recommends Better
  Auth for new projects.
- **L3** (2026-10-13) Standing instruction from stage A1, still in force: continue tasks and
  reviews automatically and stop only for a big decision. Review consent per work unit is
  granted under it.
- **L4** (2026-10-13) Exploration. Core migrations run with `search_path` set to `core`
  (`packages/core/src/runner.ts`), so an unqualified `create table` in a core migration
  lands in `core`. The codegen writes into `apps/web` (`DEFAULT_WEB_ROOT`), registry file
  `src/generated/modules.ts`. Versions on 2026-10-13: next 16.4.0, react 19.3.0,
  better-auth 1.7.7, tailwindcss 4.3.3, motion 14.1.0. Better Auth accepts a Kysely
  `PostgresDialect` with `schemaName`, and model names can be overridden.
- **L5** (2026-10-13, owner, verbatim, sent while T2 was in progress): "se puede tener una opcion para
  desabilitar el login ya que como lo voy a manejar en mi red local casi no seria necesario tener login
  pero si se expone a internet tener la posibilidad de habilitarlo". Added as S9 with task T6; T3 now
  also covers S9. The owner was told the three safeguards (on by default, off means local requests
  only, cannot enable without an administrator) and that with sign-in off anyone on the local network
  can install modules.
- **L6** (2026-10-13) T1 done, commit `5e5b061`. RED: `auth-master-key.test.ts` and `cli-admin.test.ts`
  failed before the implementation (missing module; 7 of 8 CLI cases). `auth.integration.test.ts` was
  written before `auth.ts` and `admin.ts` but first run after them, so its RED was not observed.
  GREEN: `npm test` 346 pass, 0 fail, 0 skipped; `npm run typecheck` clean. Two existing tests that
  pinned the list of core migrations and tables were updated for `0003_auth.sql`. Assessment: high,
  review due. Independent verifier launched on `5e5b061`. The library prints a warning that
  `auth_rate_limit.lastRequest` is `int8` where it expects `number`, although its own plan creates the
  column as `bigint` and reports no schema problem; rate limiting is checked end to end in T5.
- **L7** (2026-10-13) `.env.example` cannot be read or written by the agent (permission rule), so the
  README tells the owner to append `EPNEXO_MASTER_KEY` to `.env` with one command instead.
- **L8** (2026-10-13) Design direction for S6, taken without a product interview so the work is not
  blocked: operate-mode interface, one self-hosted sans family (Geist), restrained color with a single
  accent, a cooler neutral layer for the sidebar, motion only for state changes. The `impeccable`
  skill's PRODUCT.md and DESIGN.md were not created; the owner can run its `init` later.
- **L9** (2026-10-13) T1 independent verification (fresh scratch copy, own scratch databases) on
  `5e5b061`: S1, S2 and the T1 part of S3 pass, existing commands unchanged. One item needed a
  decision: the library trusts `x-forwarded-for` by default, so rotating that header never reached the
  sign-in limit (9 failed attempts, all 401), which contradicts S4. Fixed in `e7be714`: the limiter
  keys only on `x-epnexo-client-ip`. Three tests written first and observed RED (rotation, per-address
  throttling, trusted header over a spoofed one), then GREEN. Also fixed: a refused `admin create`
  printed a false "Could not validate the database schema" because the library's background schema
  check raced the pool closing; the CLI now turns that check off (the web server keeps it, where it
  makes authentication fail loudly on a mismatch). Left as they are, by decision: a password of 12
  spaces is accepted (the spec states a length rule only), and the server logs say "Invalid password"
  or "User not found" while the HTTP answers are identical. Until T3 sets the header, requests carry
  no trusted address and share one bucket, so an attacker could lock sign-in for 60 seconds; there is
  no HTTP server before T3, so nothing is exposed. The verifier's probe once ran a read-only
  `to_regclass` check against the development database on port 5436 by mistake; nothing was written.
- **L10** (2026-10-13) T2 done. The launcher (`apps/web/scripts/run.ts`, `src/server/launch.ts`)
  reads `WEB_HOST` and `WEB_PORT`, refuses to serve without `EPNEXO_MASTER_KEY`, and regenerates the
  module registry from the database before `build`. Tests written first: RED (module missing), GREEN
  12 of 12. `npm run web:build` against the empty registry: compiled in 5.9 s, 15 s wall clock for the
  whole command on the Raspberry Pi (`real 0m15.051s`). `npm test` 361 pass, 0 fail, 0 skipped;
  `npm run typecheck` clean and now covers the web app's `.tsx` through `next typegen` and its own
  tsconfig. The generated registry directory is git-ignored. `next.config.ts` reads the package names
  under `modules/` from disk, so it names no module. Tokens are OKLCH, light and dark, in
  `src/styles/tokens.css`; Tailwind reads them through `@theme inline`.
- **L11** (2026-10-13) Native review of the T1 range `981c8a7..e7be714` (lenses `risk`, `resilience`,
  `reliability`; 17 files, 1,193 lines; consent granted under L3): approved, acknowledged, authority
  burned. One warning, R3: the limiter depends on a header that only T3's server sets, and "no test
  exercises a request that lacks it". The second half is not accurate: the rotation test sends no
  trusted header and expects 429 on the sixth attempt, and the verifier observed the shared bucket.
  The first half is true and already a T3 requirement (T3 task line); T3's verifier must prove it
  against the built app. Reviewed boundary is now `e7be714`. The review needed the untracked files of
  the T2 work declared out of scope (`--untracked-scope=exclude` with the inventory digest).
