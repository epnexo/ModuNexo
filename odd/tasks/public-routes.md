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

- [x] T1 (S1, S2 manifest part, S5/S6 fields) manifest types and validation in the SDK. Route: inline. Commit: 4598bd8
- [x] T2 (S2) reserved `/hooks` in codegen and package validation, generated route wrapper. Route: inline. Commit: 8ad6e6d
- [x] T3 (S3) gate: public route matcher, `decideAccess`, proxy. Route: inline. Commit: d016b21
- [x] T4 (S4, S5, S6) runtime: signature, timestamp, rate limit, body limit. Route: inline. Commit: abfe7e8
- [x] T5 (S8) docs, skill, install review. Route: inline. Commit: 6b9e69e

## Log

- L1 (2026-10-20, user, verbatim): "commitea el ADR y abre el feature de rutas públicas continue el proceso hasta que me necesite sino tome deciciones para completar"
- L2: Route declaration: all tasks inline; no writer trigger (units share files in manifest, codegen and gate; no
  parallel disjoint units). The explorer mapped the code once (mapping trigger); reading for each edit is inline.
- L3: Decisions taken without asking, per L1: `/hooks/<module-id>/` prefix; HMAC-SHA256 only in v1; idempotency
  deferred (S7); verification wrapper is generated into the route file and calls an app-level helper.
- L4 (T1-T5 done): RED observed for T1 (12 failing), T2 (3 failing), T3 (module missing). T4 tests were written
  with the implementation in the same step, so no RED was observed for T4; the 23 tests pin the behavior now.
  T2 needed no codegen-side path check: `renderRegistration` already runs the SDK validation, so the `/hooks`
  rules are enforced once, in `validateManifest`, and the gate re-checks the `/hooks` prefix on its own (defense in depth).
- L5: Extra task beyond the plan, same feature: end-to-end proof in `apps/web/test/e2e.integration.test.ts`
  (commit 096929e): a real production build and server, a signed request answers 200, unsigned and tampered 401,
  GET 405, encoded traversal and sibling paths stay behind the gate (307 to /login), an unset secret refuses everything.
- L6: Known limits, recorded not hidden: (a) handshake providers (GET with a challenge, e.g. Meta) cannot be
  public yet; (b) rate limit and its counters are per process; (c) no idempotency (module's job, documented);
  (d) with sign-in disabled the local-only rule still blocks webhooks, so public routes need `auth require`;
  (e) the install downtime question of ADR-001 section 7.1 is still open.
