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

## Tasks

- [ ] **T1** (S1, S2, S3) Auth foundation in `@epnexo/core`: master key, auth factory, core
  migration for the auth tables, `admin create` command, tests. Route: inline. Risk: item 2
  (authentication), independent verifier after the unit's own checks.
- [ ] **T2** (S3, S6, S7) Web app scaffold: Next.js, Tailwind tokens, light and dark themes,
  typecheck covering `.tsx`, scripts, build against the empty registry. Route: inline.
- [ ] **T3** (S4) Sign-in page, auth route handler, server-side session guard, sign-out.
  Route: inline. Risk: item 2, covered by the feature's verifier.
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
