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

- [ ] T1 (S1) scaffold with `modules new`, manifest, settings, permissions, migration. Route: inline.
- [ ] T2 (S2, S3, S7) the inbound route and its store. Route: inline.
- [ ] T3 (S5) reply and the `deliver` job. Route: inline.
- [ ] T4 (S4, S6) the page and live updates. Route: inline.
- [ ] T5 (S1, S8) pack, add and apply on a real build; docs; full suite; independent verifier. Route: inline then verifier.

## Log

- L1 (2026-10-21, user, verbatim): "ok si sigamos con ese plan"
  (answering: "¿Te parece bien que el agente quede como servicio externo (el Vocero actual ya lo hace así con `/api/bot/llm`) y arranco con el inbox?")
- L2: ADR-001 accepted in 8a2496e; question 3 answered (external service). Mapping trigger fired once (explorer: module layout, capability declarations, naming rules, README examples). The Vocero inbox model was read from its public schema snapshot: `contact`, `conversation` (channel, channel_thread_ref, unread_count, last_message_at), `message` (direction, text, status, wa_message_id, origin). This feature takes the same three tables and drops everything channel-specific.
- L3: Risk: security (item 2): the first public, unauthenticated entry point that writes business data; data (item 1): a new schema with migrations. An independent verifier runs at the end.
