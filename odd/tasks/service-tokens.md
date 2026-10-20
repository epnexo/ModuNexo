# Feature: service tokens with scopes (ADR-001, capability 2)

Objective: a module can expose routes that machine callers reach with a bearer token that holds a declared scope, without a session.
Branch: feat/service-tokens (stacked on feat/public-routes). Delivery strategy: ask-on-risk (no remote work without the owner). Test runner: `npm test` (node:test via tsx), `npm run typecheck`.

## Specs

- S1. Manifest: a module declares `scopes: [{ key, label }]` (same key rules as `permissions`). A `kind: "route"` page may declare
  `scope: "<declared key>"`. `scope` cannot be combined with `public` or `permission`. A scoped route lives under
  `/svc/<module-id>/...` and nothing else may sit under `/svc`. [decision]
- S2. Storage: tokens live in `core.service_tokens`, one row per token, holding only the SHA-256 of the token (never the
  token), the module id, a name, the scopes, an optional expiry, who created it, when it was last used and whether it was
  revoked. Events (created, revoked) go to `core.service_token_events`, with no foreign key so the trail outlives a purge. [decision]
- S3. Token format `mdnx_<8 hex>_<43 base64url>`: 32 random bytes of secret. It is shown once, at creation. [decision]
- S4. CLI: `tokens create <module> --name <text> --scope <key> [--scope <key>...] [--expires-in-days <n>]` prints the token
  once; `tokens list [module]` never prints a token; `tokens revoke <id>`. A scope the module did not declare, an unknown
  module, an empty name or no scope is refused (exit 3). [decision]
- S5. Verification: `Authorization: Bearer <token>`. The token must exist, match its stored hash in constant time, not be
  revoked or expired, belong to the module of the route, and hold the route's scope. Every failure is `401` with the same
  body, except a valid token that lacks the scope, which is `403`. The handler is never called on a failure. [decision]
- S6. Gate: a declared scoped route skips the session, by the same all-readings rule as public routes; any other path
  keeps today's behavior; with sign-in disabled the local-only rule still applies.
- S7. Limits: scoped routes are rate limited per client (default 120 a minute, answers 429, in process memory) before the
  token is looked up. `last_used_at` is updated at most once a minute per token. [decision]
- S8. `uninstall --purge` deletes the module's tokens; uninstall without purge keeps them. The install review lists the
  scopes and the scoped routes.
- S9. Docs: README, the module skill, ADR-001 note.
- Not in this feature (follow-ups): a tokens screen in the web app; a per-request body limit for scoped routes (the
  module reads the body); token rotation.

## Tasks

- [ ] T1 (S1) manifest `scopes` and page `scope` in the SDK. Route: inline. Commit: pending
- [ ] T2 (S2, S3, S5, S8 purge) migration 0010, `TokenService`, purge. Route: inline. Commit: pending
- [ ] T3 (S4) CLI `tokens`. Route: inline. Commit: pending
- [ ] T4 (S1, S6, S8 review) codegen wrapper, `/svc` gate, install review. Route: inline. Commit: pending
- [ ] T5 (S5, S7) web: shared rate limiter, `scopedRoute` wrapper. Route: inline. Commit: pending
- [ ] T6 (S9) docs, e2e on the fixture, full suite, independent verifier. Route: inline. Commit: pending

## Log

- L1 (2026-10-20, user, verbatim): "sigue con el token de servicio"
- L2: Route declaration: all tasks inline; no writer trigger (tasks share SDK, core, codegen and gate files). Mapping trigger
  fired once (explorer). Risk: security (item 2) and a new persisted table (additive, item 1 does not apply), so an
  independent verifier runs at the end.
- L3: Decisions taken without asking, per the standing instruction in the previous feature (L1 of public-routes): `/svc/<id>/`
  prefix; scopes declared by the module; hashed storage; CLI first, no UI.
