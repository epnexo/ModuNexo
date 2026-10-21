# ADR-001: Modules become active participants of the runtime

Status: accepted
Date: 2026-10-20

## 1. Focus

Decide which generic capabilities the **core** must gain so that business modules (messaging inbox, pipeline,
AI agent, evaluation lab, analytics, scheduling) can exist as modules. This ADR is about the core only. The
modules themselves come afterwards, each with its own feature document.

Ideas come from a reference open source messaging CRM that solves the same needs inside one monolith. We adopt
its ideas, never its code.

## 2. Context

Today a module is **passive**: it declares pages, route handlers, navigation, permissions, settings and its own
Postgres schema, and runs only while an authenticated administrator makes a request.

Verified in the code:

- `/api` is a reserved path (`packages/core/src/codegen/render.ts:70`), so a module cannot declare routes there.
- Without a session only the sign-in page, the auth endpoints, the brand logo and `/api/health` are reachable
  (`apps/web/src/server/access.ts`). A module cannot receive an outside call.
- There is no background work, no realtime stream and no channel between modules.
- Modules run in the platform process with its database credentials; the SDK states this is a contract, not a
  sandbox (`packages/sdk/src/db.ts:12-14`).
- The platform is single tenant, with two roles (`admin`, `operator`).

## 3. Decision

The core gains the capabilities below. Each one is opt-in per module through the manifest; a module that declares
none stays passive. Each capability is built as its own feature with its own task document.

| # | Core capability | Idea taken from the reference | What the core must do differently | Unlocks | Order |
|---|---|---|---|---|---|
| 1 | Public routes per module | Signed inbound webhooks | Declared in the manifest, signature check required, idempotency key, replay window, rate limit | Inbox, channels, scheduling | 1 |
| 2 | Service tokens | Service API for an external agent | One token per module with scopes (the reference uses one global key) | External agents, integrations | 2 |
| 3 | Background jobs | Outbox with lease, retry, resume on boot | Plus scheduling, which the reference lacks; state the single-process limit | Agent, lab, reminders | 3 |
| 4 | Events and realtime | Post-commit event bus and SSE with catch-up | Event types registered by modules, not a closed list; catch-up by cursor | Live inbox and pipeline | 4 |
| 5 | File and attachment API | Files on disk behind an adapter | Storage adapter from the start (disk first, object storage later) | Inbox | 5 |
| 6 | LLM provider adapter | OpenAI-compatible adapter with probe | Keys come from module secret settings | Agent, lab | 6 |

Not adopted: per-integration credential tables (the core already has one encrypted settings store), flag-based
optional features (the module lifecycle already covers install and enable), and the reference's monolith layout.

Status of the table: capability 1 (public routes with signature, `/hooks/<module-id>/`), capability 2 (service
tokens with scopes, `/svc/<module-id>/`), capability 3 (background jobs run by a separate worker process, a Postgres
queue), capability 4 (events and realtime), capability 5 (files behind a storage adapter, a disk folder first) and capability 6 (a chat model through an
OpenAI-compatible adapter, configured by the module's own settings) are built;
see `odd/tasks/public-routes.md`, `odd/tasks/service-tokens.md`, `odd/tasks/background-jobs.md`,
`odd/tasks/events-realtime.md`, `odd/tasks/files-attachments.md` and `odd/tasks/llm-adapter.md`.
Open question 2 of section 7 is answered for jobs and events: they persist in Postgres. Events are written in the
publisher's own transaction (an outbox that is also the bus), announced with `LISTEN`/`NOTIFY` at commit, delivered to
modules as jobs and to browsers as server-sent events with a cursor.

## 4. Rules that do not change

- The core never imports a module by name.
- Modules never import each other's code. They communicate through events and read-only SQL on modules listed in
  `dependsOn`.
- A module owns its schema and nothing else.

## 5. Alternatives considered

- **Stay passive.** Cheapest, but only request-bound modules (pipeline, analytics, basic scheduling) are
  possible; the inbox, agent and lab are not.
- **Heavy work as external services behind a contract.** Healthy for the AI agent and still possible on top of
  service tokens, but it does not remove the need for public routes, jobs and events in the shell.
- **Copy the monolith with flags.** Gives up the module lifecycle this project exists to provide.

## 6. Risks

- **No sandbox.** A bug in a public route or token handler reaches the whole database. Every public entry point
  needs input validation and the least privilege the manifest can express.
- **First unauthenticated entry points** in the platform: signature checks, replay protection and rate limiting
  are part of capability 1, not a later hardening.
- **Single process.** Events, rate limits and jobs held in memory do not survive a second instance. State the
  limit, or persist them.
- **Single tenant and two roles.** Token scopes do not replace a users-and-roles feature.

## 7. Open questions

1. **Install downtime.** Answered by `odd/tasks/install-without-downtime.md`: a module change builds into a build
   directory of its own while the server keeps serving the current one, and the restart that follows is the switch. The
   only gap left is that restart, seconds long; a restart with no gap at all would need a proxy in front of the server.
   (Originally: installing or enabling a module needed a cold build during which pages failed, acceptable for passive
   modules and not for modules receiving live traffic.)
2. Do jobs and events persist in Postgres or stay in memory?
3. Is the AI agent a module, or an external service reached with a service token? Answered: an external service. It calls the platform with a service token (`/svc/<module-id>/`) and receives work as events; the platform hosts no agent loop. The model adapter (capability 6) stays for modules that call a model themselves.

## 8. First step

Capability 1, public routes with signature verification, because every inbound flow depends on it.
