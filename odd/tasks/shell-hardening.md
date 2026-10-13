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
  most 50, none shorter than /8) of reverse proxies whose `x-forwarded-for` the shell may believe. Validated, stored in
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

- [x] **T1** (S1) SDK: `pages[].permission` and its validation. Route: inline.
- [x] **T2** (S3, S4) Core: IP and CIDR parsing and matching, and the pure rule that picks the effective client
  address. Route: inline. Risk: item 2 (it decides who is rate limited and as whom).
- [x] **T3** (S3) Core: the `security.trustedProxies` setting (validation, storage, audit) and its CLI key.
  Route: inline.
- [x] **T4** (S2, S4, S5) Web: the permission rules, `decideAccess` and the gate; the effective client address
  handed to the sign-in limiter. Route: inline. Risk: item 2 (guards).
- [x] **T5** (S3) Web: the Security section of Settings and its API route. Route: inline.
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
- **L4** (2026-10-13) T1 to T5 done, tests first (RED observed for each unit: missing module or missing field).
  - T1: `pages[].permission` in the SDK validator; it must be a key the manifest declares, and a manifest that
    declares none refuses it.
  - T2: `auth/ip.ts` (BigInt based): `parseIp` (an IPv4-mapped IPv6 address is the IPv4 address it wraps,
    leading zeros refused), `formatIp` (one canonical text per client), `parseCidr`, `cidrContains` and
    `effectiveClientAddress`, which believes the header only from a trusted connection, reads it from the right,
    and falls back to the connection on an entry it cannot read, so junk cannot mint identities.
  - T3: `security.trustedProxies` (`validateTrustedProxies`, `readTrustedProxies`, `setTrustedProxies`): at
    most 50 entries; `0.0.0.0/0` and `::/0` refused ("would trust every address"); a stored value that does not
    validate as a whole trusts nobody; audited without its value; CLI key with `list`, `get`, `set`, `unset`.
  - T4: `route-permissions.ts` (page rules by route pattern including `[id]`, `[...x]`, `[[...x]]`; nav rules by
    prefix, query and fragment dropped, non-path links ignored; every covering permission is required),
    `decideAccess` gets `permitted` (authentication is checked first, so a visitor without a session is sent to
    sign in and told nothing about permissions), the gate computes it from the session's role and rewrites
    `x-epnexo-client-ip` for the limiter when the connection is trusted. The locality rule still reads the
    original request.
  - T5: `PUT /api/settings/security`, the Security section of the screen and `readTrustedProxyList`.
  - Found by running it, again: the server entry runs under Node's strip-only TypeScript and my new
    `auth -> settings` import pulled in classes with parameter properties, so the server did not start. The
    two error classes moved to `settings/errors.ts`, and `launch.test.ts` now loads `serve.ts` exactly as the
    production server is started, so this class of break is caught by a test and not by a user.
  - Expectations I had wrong, corrected in the test and not in the code: a trailing slash is Next.js's to
    normalise (308), and a module route without a session redirects to sign in because only `/api` answers 401.
  `npm test` 661 pass, 0 fail, 0 skipped; typecheck clean. Remaining: the independent verifier and the native
  reviews (T6).
- **L5** (2026-10-13) Native review of `a5f2b60..4e9c620` (25 files, 1,201 lines; lenses `risk`, `resilience`,
  `reliability`): approved, acknowledged, burned, with three warnings. Independent verifier at the same
  commit: no blockers, S1 to S6 pass, 356 bypass attempts per visitor kind with zero protected bodies,
  trusted-proxy buckets read straight from `core.auth_rate_limit`. What was done with each:
  - Percent-decoding (reported twice by the review). I checked it before deciding: `NextURL.pathname` keeps
    `%72estricted` encoded, and the verifier confirmed on Next 16.4 that such spellings answer 404, so it is not
    exploitable today. It was still fixed, because a rule that compares only the raw spelling fails open the day
    a version decodes before resolving. `requiredPermissions` now applies every rule to the path as written, to
    each segment decoded once, and to each decoded as far as it goes (up to four rounds, splitting again on a
    decoded slash), and adds the permissions up: the strictest reading wins. The end-to-end test sends nine
    encoded spellings as a user and as nobody and asserts none returns 200 or protected content.
  - One extra read per request behind a proxy: left as is on purpose. The gate already reads the sign-in mode on
    every request; the verifier measured 26 against 28 ms medians with and without the header. A cache would add
    staleness after a change for no measurable gain.
  - Verifier advisories fixed, tests first: the page-permission error now also names the page's path; a
    navigation entry with `href: "/"` and a `permission` is refused by the manifest validator (it produced no rule
    and would otherwise have to cover the whole shell); the Security form listed a stored string as if it were
    active while nobody was trusted (`readTrustedProxyList` is now as strict as `readTrustedProxies`); ranges
    shorter than /8 are refused, which also removes `0.0.0.0/1` and `::/1`; the connection address is written in
    one canonical form when it is stamped, so an IPv4 client of a dual-stack listener cannot be counted under two
    identities (`::ffff:10.0.0.2` and `10.0.0.2`).
  - Verifier advisory, spec reworded (S2 above): a visitor without a session is redirected, not given `403`.
    The echo of a refused entry in the 422 body is the operator's own input and stays.
  `npm test` result is recorded in L6.
