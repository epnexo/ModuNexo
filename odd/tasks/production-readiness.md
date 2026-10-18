# Production readiness: health and logs, backup and restore, CI and container, users and roles
Branch: feat/production-readiness (stacked on feat/module-scaffold). Delivery: ask-on-risk. Runner: `node --import tsx --test`, TEST_DATABASE_URL on 127.0.0.1:5436, `npm run typecheck`.

## Specs
- S1. Health: a public `GET /api/health` that answers 200 `{ "status": "ok", ... }` when the database answers and 503 `{ "status": "degraded", ... }` when it does not; it says nothing about the host, paths, versions of libraries or errors; `Cache-Control: no-store`; reachable without a session (a probe has none) but, with sign-in disabled, still only from the local network like everything else.
- S2. Logs: one line per event as JSON (`ts`, `level`, `event`, fields) when `NODE_ENV=production` or `LOG_FORMAT=json`, readable text otherwise; the existing `console.*` calls in the web app, the access gate, the pool and the supervisor go through it; no secret, password, cookie or token is ever a field.
- S3. Backup and restore: a documented, tested procedure and scripts that save the database, the installed modules and the received packages, and restore them into an empty database; the README says the master key (`EPNEXO_MASTER_KEY`) must be kept separately because stored secrets are encrypted with it.
- S4. CI and container: a CI workflow that installs, type-checks and runs the tests on every push and pull request against a Postgres service; a Dockerfile for the web app and a compose service for it, so a deployment is repeatable; the lockfile is the source of versions (`npm ci`).
- S5. Users and roles: more than one person can sign in, each with a role (at least `administrator` and a role that can use modules but not change the platform); module permissions (`permission` keys in manifests) are granted to roles; the gate enforces them. The model needs the owner's decision before building.
- Out of scope (decided earlier, not asked now): package signing, sandbox, 2FA.

## Tasks
- T1 S1 S2 inline — health endpoint + structured logger + wiring — done (RED: 3 files failing; GREEN 29/29; real server: 200 ok no-store, foreign Host 403, JSON refusal line)
- T2 S3 inline — backup/restore scripts, tested restore into a scratch database, README — done (6/6 round trip, private perms, no master key, never overwrites, tamper refused, failed backup leaves no folder)
- T3 S4 inline — CI workflow, Dockerfile, compose service, LICENSE and SECURITY.md
- T4 S5 inline — users and roles (design question first)

## Log
- L1 (2026-10-18, owner): "si, arranca con el lote en ese orden" (after: "primero confirmar que la base esta muy bien que se pueda utilizar en hambiente profesional"; the order proposed: health and logs, backup and restore, CI and Dockerfile, users and roles last).
- L3: T2 tests found two real script bugs: the mode probe drained stdin (restore read an empty dump) and `fail` exits so an ERR trap never cleaned a half-written backup; fixed with a cached mode and an EXIT trap. Docker briefly disappeared from the host mid-task; the owner restored it and the 6 tests passed.
- L2: audit evidence before starting: no CI config, no app Dockerfile (compose has only the database), no health endpoint, no backup procedure, only an administrator account, no LICENSE/SECURITY.md.
