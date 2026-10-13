# Shell hardening: route permissions and trusted proxies

Objective: close the two protections the previous stages left open before module installation arrives: a
manifest `permission` must be enforced on the route, not only hide a link, and the sign-in rate limit must key on
the real client when the shell sits behind a reverse proxy the owner trusts.
Branch `feat/shell-hardening`, stacked on `feat/shell-settings-appearance` (head `a5f2b60`). Delivery strategy
`auto-chain`; chain strategy not chosen (no remote). Test runner: `npm test`, `npm run typecheck`, the end-to-end
test in `apps/web/test`. Strict test-first.

## Specs

Quoted fragments are the owner's words; the rest is the plan agreed in the session, assumptions marked.

- **S1 A page can name the permission it needs.** Assumption: `pages[].permission`, optional, must be one of the
  permission keys the same manifest declares; anything else is a manifest error naming the page.
- **S2 The gate enforces permissions on routes.** A request to a path covered by a permission is served only to
  someone who holds it: the local operator and an administrator (the only roles the shell knows; there is no way
  yet to grant a module permission to another user, so everyone else is refused). Everyone else gets `403`. A
  page's own `permission` covers that page's route pattern (dynamic segments included). A nav entry's
  `permission` covers its `href` and everything below it, so a hidden link can no longer be reached by typing the
  address. When several rules cover a path all must be held. It applies to pages and to HTTP routes alike, after
  the sign-in and local-only checks, and fails closed like the rest of the gate.
- **S3 Trusted proxies are a setting.** `security.trustedProxies`: a list of IP addresses and CIDR ranges (at
  most 50) of reverse proxies whose `x-forwarded-for` the shell may believe. Validated, stored in
  `core.platform_settings`, audited like any setting, editable on the Settings screen (Security section) and with
  `epnexo settings`. Empty by default: nobody is trusted.
- **S4 The sign-in limit keys on the real client behind a trusted proxy.** When the connection comes from a
  trusted proxy, the limiter's key is the nearest address in `x-forwarded-for` (reading from the right) that is
  not itself a trusted proxy; otherwise it is the connection address, and a forwarded header from a connection
  that is not trusted is never believed.
- **S5 Locality is not loosened.** The rule that decides whether a request is local while sign-in is off keeps
  looking at every address a request carries. A trusted proxy changes which client the limiter counts, never what
  counts as local.
- **S6 Documentation.** The README explains both, and what a manifest author writes.

## Tasks

- [ ] **T1** (S1) SDK: `pages[].permission` and its validation. Route: inline.
- [ ] **T2** (S3, S4) Core: IP and CIDR parsing and matching, and the pure rule that picks the effective client
  address. Route: inline. Risk: item 2 (it decides who is rate limited and as whom).
- [ ] **T3** (S3) Core: the `security.trustedProxies` setting (validation, storage, audit) and its CLI key.
  Route: inline.
- [ ] **T4** (S2, S4, S5) Web: the permission rules, `decideAccess` and the gate; the effective client address
  handed to the sign-in limiter. Route: inline. Risk: item 2 (guards).
- [ ] **T5** (S3) Web: the Security section of Settings and its API route. Route: inline.
- [ ] **T6** (S6) End-to-end test, README, independent verifier, native reviews. Route: inline plus verifier.

Forecast: about 1,200 authored changed lines; one slice per task.

## Log

- **L1** (2026-10-13, owner, verbatim): "si primero el enduresimiento". Context: the answer to "¿Hago primero el
  endurecimiento y después A4, o vamos directo a A4?", asked at the close of A3.
- **L2** Decisions taken without asking, because each has a safe default and none changes what the owner asked:
  the permission model stays "operator and administrator hold every permission, others none" (a way to grant
  permissions is a users-and-roles feature, not this one); a nav entry's permission protects its prefix (the
  stricter reading, so a hidden link cannot be typed in); trusted proxies change only the rate-limit key, so the
  local-only rule cannot be loosened by a setting.
- **L3** (2026-10-13) Exploration. `NavEntry.permission` already exists and is validated against the module's
  declared keys; `PageDeclaration` has no `permission`. The gate (`apps/web/src/proxy.ts`) already has the
  session and the sign-in mode per request and feeds `decideAccess`. The sign-in limiter reads the request header
  `x-epnexo-client-ip` (`CLIENT_IP_HEADER`), which `serve.ts` stamps from the socket and which has no database
  access, so the effective client address has to be computed in the gate and written over that header before the
  auth route runs.
