# Feature: inbox module (the first business module, built on the platform capabilities)

Objective: a module `inbox` in `modules-src/inbox/` that receives messages from outside channels, lets an operator read and answer them, and updates live. It is the first module to use public routes, jobs, events and secret settings together, so it shows what the core still lacks.
Branch: feat/inbox-module (local; only `main` is published, no push without the owner). Delivery strategy: ask-on-risk. Test runner: `npm test` (node:test via tsx), `npm run typecheck`; module code is tested through the packages' test folders because modules have no test runner of their own.

## Specs

- S1. A module `inbox` (id `inbox`, schema `inbox`) in `modules-src/inbox/`, made with `modules new`, packable with `modules pack`, installable with `modules add` and `modules apply`. [decision: modules-src is the tracked place for modules we write]
- S2. Inbound: `POST /hooks/inbox/messages`, a public route verified by HMAC-SHA256 over the raw body with the secret setting `webhook_secret` (header `x-signature`, prefix `sha256=`). The body is JSON: `channel`, `threadRef`, `messageId`, `text`, and optionally `contact: { ref, name }`. A message with a `messageId` already stored for that `channel` is accepted and stored once (answer 200, no second row, no second event). [decision: a channel-neutral contract first; real channel adapters (WhatsApp, Instagram, Messenger) are follow-ups, because Meta's GET handshake cannot be a public route yet]
- S3. Storing an inbound message creates the contact and the conversation when they do not exist, increments the unread count, and publishes `inbox.message.received` in the same transaction, so a rolled-back write announces nothing.
- S4. A page `/inbox` for operators: the conversation list (newest activity first, unread count) and the selected conversation's messages; opening a conversation marks it read. New messages appear without reloading (server-sent events on `inbox.message.received`).
- S5. Reply: an operator writes a text in a conversation; it is stored as an outbound message with status `queued` and a job `deliver` is enqueued. The job sends it to the URL in the setting `outbound_url`, signed with the secret setting `outbound_secret` in the same way as S2, and marks the message `sent`; a failure retries (the platform's attempts) and ends as `failed` with the reason shown to the operator. With no `outbound_url` set the message stays `queued` and the page says so.
- S6. Only operators with the permission `inbox.read` see the page and the events; only those with `inbox.write` reply.
- S7. Nothing of a message's text is written to the platform log.
- S8. README section for module authors "A real module: inbox" saying what it does, the webhook contract, and what it does not do.
- Not in this feature (follow-ups): attachments and files, real channel adapters, assigning conversations, templates, the AI agent (an external service, ADR-001 question 3), search, pagination beyond the newest 50 conversations, deleting conversations.

## Tasks

- [x] T1 (S1) scaffold with `modules new`, manifest, settings, permissions, migration. Route: inline. Commit: e54cb51
- [x] T2 (S2, S3, S7) the inbound route and its store. Route: inline. Commit: e54cb51 (RED: module missing; 9 tests)
- [x] T3 (S5) reply and the `deliver` job. Route: inline. Commit: 4754d36 (RED: module missing; 10 tests)
- [x] T4 (S4, S6) the page and live updates. Route: inline. Commit: 3fb13a9 (RED: module missing; 6 tests for the reads; the page itself is proved on a real build)
- [x] T5 (S1, S8) pack, add and apply on a real build; docs; full suite; independent verifier. Route: inline then verifier. Commit: 2c86df9, df31c0c (suite 1452/1452; verifier: no blockers)

## Log

- L1 (2026-10-21, user, verbatim): "ok si sigamos con ese plan"
  (answering: "¿Te parece bien que el agente quede como servicio externo (el Vocero actual ya lo hace así con `/api/bot/llm`) y arranco con el inbox?")
- L2: ADR-001 accepted in 8a2496e; question 3 answered (external service). Mapping trigger fired once (explorer: module layout, capability declarations, naming rules, README examples). The Vocero inbox model was read from its public schema snapshot: `contact`, `conversation` (channel, channel_thread_ref, unread_count, last_message_at), `message` (direction, text, status, wa_message_id, origin). This feature takes the same three tables and drops everything channel-specific.
- L3: Risk: security (item 2): the first public, unauthenticated entry point that writes business data; data (item 1): a new schema with migrations. An independent verifier runs at the end.
- L4: Installed on the dev server with `modules add` and `modules apply`. The first apply failed at the build and was rolled back without touching the serving build (169 probes during it, all 200). Two causes: the archive predated a type fix of mine (`interface` does not satisfy `Record<string, unknown>`; now `type`), and a core bug: the generated public route wrote `const rule = {...}` and TypeScript widened `"hex"` to `string`, so any public route declaring `encoding` could not build. Fixed in the core with a test that failed first (the "fix(core)" commit). The second apply succeeded (148 probes, all 200). Live: `/inbox` 200, a POST with no signature 401, GET 405.
- L5: Findings for the core, not fixed here: a module page cannot ask who is viewing (so S6 is enforced only at the gate: the reply form is shown to every reader and the send is refused to those without `inbox.write`); replies queued before an outbound URL is set are not sent when it is; the SDK has no helper for the same-origin rule, so the module copies it.
- L6 (2026-10-21, user, verbatim, answering a versioning proposal): "si el plan esta bien" — the platform versioning is the next feature, after this one closes.
- L7: Independent verifier (S1-S8, security focus, probes in a scratch copy): no blockers. S4 and S6 unproven by it (page and gate are proved by the install on a real build, L4). Advisories fixed with tests that failed first (df31c0c): a NUL character in a signed body or a reply gave a 500, now 400; `data:` and other non-http outbound URLs reported `sent` without sending, now the reply fails at once. Documented: delivery is at-least-once, and the outbound URL is an administrator's choice (an internal address would be called). Left: the origin check compares Host literally (safe direction).
