# Feature: public routes per module (ADR-001, capability 1)

Objective: a module can declare an unauthenticated inbound HTTP route, protected by a mandatory signature check.
Branch: feat/public-routes. Delivery strategy: ask-on-risk (no remote work without the owner). Test runner: `npm test` (node:test via tsx), `npm run typecheck`.

## Specs

- S1. Manifest: "Declared in the manifest, signature check required". A `kind: "route"` page may carry `public`, and
  `public` must declare the signature check; a public route without one is a manifest error. `public` and
  `permission` are mutually exclusive on the same page. [decision]
- S2. Path: `/api` is reserved, so public routes live under a new shell-owned prefix `/hooks/<module-id>/...`.
  A public route outside its own `/hooks/<module-id>/` is a manifest error; a non-public page cannot sit under
  `/hooks`. [decision]
- S3. Gate: a request to a declared public route skips the session; any other path keeps today's behavior. In
  sign-in `disabled` mode the local-only rule still applies (webhooks cannot reach a non-local request). Encoded
  path variants must never open a path that is not declared public. [decision]
- S4. Verification: HMAC-SHA256 over the raw body, compared in constant time, with the secret read from a module
  `secret` setting. A missing or unreadable secret, a missing header or a mismatch answers 401 and never calls the
  module handler (fail closed). [decision]
- S5. "replay window": an optional signed timestamp header with a tolerance; when declared, a stale or missing
  timestamp answers 401.
- S6. "rate limit": a per-client limit on public routes (answers 429) and a body size limit (answers 413). The
  limits live in process memory; this is stated, not hidden (ADR-001 section 6).
- S7. "idempotency key": NOT built in this feature. The module owns deduplication; the core documents the pattern.
  Recorded as a follow-up. [decision, narrows the ADR table]
- S8. Docs: README, the module skill and the install review describe the field and the rules.

## Tasks

- T1 (S1, S2 manifest part, S5/S6 fields) manifest types and validation in the SDK. Route: inline. Commit: pending
- T2 (S2) reserved `/hooks` in codegen and package validation, generated route wrapper. Route: inline. Commit: pending
- T3 (S3) gate: public route matcher, `decideAccess`, proxy. Route: inline. Commit: pending
- T4 (S4, S5, S6) runtime: signature, timestamp, rate limit, body limit. Route: inline. Commit: pending
- T5 (S8) docs, skill, install review. Route: inline. Commit: pending

## Log

- L1 (2026-10-20, user, verbatim): "commitea el ADR y abre el feature de rutas públicas continue el proceso hasta que me necesite sino tome deciciones para completar"
- L2: Route declaration: all tasks inline; no writer trigger (units share files in manifest, codegen and gate; no
  parallel disjoint units). The explorer mapped the code once (mapping trigger); reading for each edit is inline.
- L3: Decisions taken without asking, per L1: `/hooks/<module-id>/` prefix; HMAC-SHA256 only in v1; idempotency
  deferred (S7); verification wrapper is generated into the route file and calls an app-level helper.
