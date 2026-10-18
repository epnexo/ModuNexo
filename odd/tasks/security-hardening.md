# Security hardening (owner-approved audit follow-up)
Branch: feat/security-hardening (stacked on feat/brand-profile). Delivery: ask-on-risk. Runner: `node --import tsx --test`, TEST_DATABASE_URL on 127.0.0.1:5436, `npm run typecheck`.

## Specs
- S1. Every response carries security headers: `X-Frame-Options: DENY`, `frame-ancestors 'none'` (and `base-uri 'self'`, `form-action 'self'`, `object-src 'none'`) in a CSP, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`; `Strict-Transport-Security` only when `WEB_PUBLIC_URL` is https. No `script-src` (the app has inline scripts).
- S2. `next build` runs with a minimal environment (allowlist), so the build never sees `EPNEXO_MASTER_KEY`, `DATABASE_URL` or other secrets.
- S3. Settings > Security shows a warning when sign-in cookies are not `Secure` because `WEB_PUBLIC_URL` is not https.
- S4. Installing a package needs an explicit acknowledgement: the review says the module runs with full platform permissions, the user ticks it, and the server refuses a start without `acknowledge: true`.
- Not in scope (decided): asking for an admin credential to install when sign-in is disabled (it would block first setup); package signing; sandbox.

## Tasks
- T1 S1 inline — done (security-headers.ts, next.config headers(); RED then GREEN)
- T2 S2 inline — done (buildEnvironment allowlist in install/build.ts; real builds in the e2e pass)
- T3 S3 inline — done (notice in Settings > Security)
- T4 S4 inline — done (UI checkbox + server requires acknowledge: true; RED then GREEN)
- T5 inline — done: e2e repairs found on the way (profile missing in e2e DBs, a test wiping platform_settings, Apps assertion stale, Tabs now keeps panels mounted). Evidence: e2e.integration + install.e2e 44/44.

## Log
- L1 (2026-10-18, owner): "si me parece bien realice una validacion y si hay una comparacion con projectos similares para buscar mejoras quiero validar esas competencias para ver que mejoras se pueden realizar para tener un projecto mas seguro"
- L2 (2026-10-18, owner): "si, arranca con el endurecimiento" (points 1 to 4 of the audit: headers, minimal build env, Secure-cookie notice, install confirmation).
- L3 (2026-10-18): the e2e files had been failing since the brand-profile and Apps-tabs branches (10 failures, same on the code without hardening); causes were in the tests plus Tabs rendering only the active panel. Fixed here.
