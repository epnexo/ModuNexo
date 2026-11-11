---
name: modunexo-module
description: "Create, extend or upgrade a custom module for the modunexo platform: generate it, give it data, relate it to other modules, pack and install it. Trigger: creating or changing a module under modules-src/, a manifest.ts, a module migration, or a module page; also its styling (CSS, cards, badges, theme)."
license: Apache-2.0
metadata:
  version: "1.0"
---

## When to use

The user wants a new module (documents, contacts, anything), a change to one, or to connect two modules. The platform
(this repository) stays as it is; a module is a separate package that is generated, packed and installed.

## Before you build (do not redo what exists)

Do these three checks first; they are what keeps a new module on the platform's line instead of a second copy of it.

1. **Start from a sibling.** Open the module closest to yours in the modules repository (`ModuNexo-modules`, folder
   `modules/<id>`): `contacts` for lists, forms and a pipeline, `agenda` for settings and bookings, `inbox` for a
   conversation view, `ai-usage` for charts. Copy its structure, not its code, and keep its file names and `tests/<id>/` layout.
2. **Use what the platform already gives** (see "Styling" under Rules): tokens, the global classes (`card`, `badge`,
   `icon-tile`, `seg`, `stat`, `notice`, `data-table`, `btn`, `input`, `field`), the spacing variables, the SDK. A module that needs a pattern none of them offers writes only that
   pattern, scoped and prefixed.
3. **A pattern needed twice belongs in the platform.** If a second module would need what a first one built (a dialog,
   a tab strip, an empty state, a file field), stop and add it to the platform's styles instead of
   copying it. The full contract is the section "Styling a module" of `docs/GUIDE.md` in the modules repository.

## Steps

1. **Decide the shape before generating.** One module is one concern. Pick the `id` (kebab-case, also the folder and
   the URL), what data it owns (its own Postgres schema, named after the id with `_`), and which other modules it must
   read. Ask the user only for what you cannot infer.
2. **Generate.** `npm run modunexo -- modules new <id> --name "<Name>"` writes `modules-src/<id>/` (manifest, a first
   migration, a page that lists and adds rows with `getDb`). Edit that folder; do not copy another module's code. Keep real modules in their own repository: pass `--dir <parent>` (a module there is `<parent>/<id>/`); the default `modules-src/` is untracked and meant for trying things out.
3. **Data.** Tables live in `migrations/NNNN_name.sql`, run with `search_path` set to the module's schema, so write
   `create table items (...)` without a schema prefix. **Applied files are append-only**: to change a table add
   `0002_*.sql` and raise `version` in `manifest.ts` AND `package.json` (they must match; an upgrade to the same
   version does nothing).
4. **Read and write data** only through the SDK, from a page, a server action or a route, never at import time:
   ```ts
   import { getDb } from "@modunexo/sdk";
   const { rows } = await getDb("my-module").query<{ id: number }>("select id from items where id = $1", [id]);
   await getDb("my-module").transaction(async (tx) => { await tx.query("..."); await tx.query("..."); });
   ```
   Always use `$1` placeholders. One statement per `query` call. A page that reads data declares
   `dynamic: "force-dynamic"` in the manifest. Writes from a form use a server action (it checks the request origin);
   a plain route handler must check `Origin` itself.
5. **Relate to another module.** Add it to `dependsOn` (`{ "contacts": "^1.0.0" }`), then read it:
   `getDb("my-module").reader("contacts").query("select id, name from people")`. The handle is READ ONLY in the
   database and only exists for modules listed in `dependsOn`; any other id throws `DbAccessError`. To change another
   module's data, link by id and let that module expose its own page or route; there are no cross-module writes.
   Never import another module's code.
6. **Everything else the manifest can declare:** `permissions` (and `permission` on `nav`/`pages`, enforced at the
   gate), `settings` read with `getSetting("my-module", "key")`, `hooks` (`onInstall`, `onEnable`, `onDisable`,
   `onUpgrade`, `onUninstall`). See the README sections "The module contract" and "Settings and appearance".
7. **Package and install.**
   ```bash
   npm run modunexo -- modules pack modules-src/<id> --out <id>.tgz     # prints the SHA-256
   npm run modunexo -- modules add <id>.tgz --sha256 <hex>              # review only; nothing runs
   npm run modunexo -- modules apply <hex>                              # place, build, migrate, restart
   ```
   The same flow is on the Apps screen. Open the module's page and add a row to prove the data path.

## Rules

- A module cannot bring npm packages; it can use what the platform already has (React, Next, the SDK). Its package
  name is `@local/<id>`; the `@modunexo` scope is the platform's.
- Every `kind: "page"` file must `export const metadata = { title: "..." }` next to its default export: the generated
  route re-exports both, and a page without it fails the web build.
- Pages cannot sit under paths the shell reserves; `pack` and `add` list every problem. `/api` is reserved.
- An inbound webhook is a `kind: "route"` page with `public: { signature: { secret, header } }`, declared under
  `/hooks/<module-id>/` with explicit `methods` (no GET), and a `secret` setting that holds the shared key. The shell
  verifies the HMAC-SHA256 of the body before your handler runs; never open a route without a signature, and
  deduplicate events yourself (the shell does not). See the README section "Public routes".
- An API for machine callers is a `kind: "route"` page with `scope: "<key>"`, declared under `/svc/<module-id>/`, and
  the key listed in the module's `scopes`. The operator issues tokens with `tokens create`; the shell checks the bearer
  token and scope before your handler runs and reads no body, so cap and validate it yourself. Never combine `scope`
  with `public` or `permission`. See the README section "Service tokens".
- Work outside a request (syncs, cleanups, retries) is a job: declare `jobs: [{ name, entry, every? }]`, make the default
  export of `entry` an `async (ctx: JobContext) => void`, and call `enqueueJob(moduleId, name, payload?, { dedupeKey? })`.
  A worker process runs it with `getDb` and `getSetting`; it can run more than once (at-least-once), so make it
  idempotent, and honour `ctx.signal`. Keep the job file free of Next.js imports: it does not run inside Next. See
  the README section "Background jobs".
- To tell other modules or the browser that something happened, declare `events: [{ name, permission? }]` and call
  `publishEvent(moduleId, name, payload?, { tx })` as the last step of the transaction that wrote the data (`tx` from
  `getDb(...).transaction`). Only an event with a `permission` is streamed to browsers (`GET /api/events`); never put a
  secret in a payload. Another module reacts with `subscriptions: [{ event, job }]` (the module must be in `dependsOn`),
  and the job receives `{ event: { id, type, payload, createdAt } }`. See the README section "Events and realtime".
- To keep a file (an attachment, an export, an image), declare `files: { maxBytes?, accept?, permission? }` and use
  `putFile(moduleId, { name, data, ref? }, { tx })`, `getFile`, `statFile`, `listFiles`, `deleteFile`; never write to the
  disk yourself. Keep the returned `id` in your own table, pass `tx` so the file and your row commit together, and read the
  body in your route (the platform has no multipart parser). The type is decided from the bytes, not the name. Only a file
  of a module with `files.permission` can be downloaded by a browser, at `GET /api/files/<module>/<id>`, always as an
  attachment. See the README section "Stored files".
- To let an administrator test what a module's settings point at (an address, a token), declare
  `checks: [{ key, label, description?, path }]`, each `path` a `kind: "route"` page that answers `POST` and has a `permission`
  (never `public` or `scope`). The Settings screen shows a button per check; the platform POSTs with no body and shows the JSON
  answer `{ ok: boolean, message: string }` (SDK type `CheckResult`) as plain text, so the message carries no secret and no text
  from the tested system. The route checks the request origin itself. It runs with the saved settings. Needs SDK 0.1.3: set
  `platform: "^0.1.3"`. See the README section "Connection checks".
- To call a chat model, declare the three settings (`string` endpoint, `secret` key, `string` model) and
  `llm: { baseUrlSetting, apiKeySetting?, modelSetting? }`, then use `chat(moduleId, { messages, ... })` and `probeLlm`; never
  use `fetch` or a provider SDK, and never read the key yourself. Catch `LlmError` and branch on `error.code`. The wire format
  is OpenAI-compatible, so a local server works too. Do not build the endpoint from user input. See the README section
  "Language models".
- **Styling.** A module looks like the platform because it reads the platform's tokens, never because it copies values.
  - Colors, borders and text: token utilities only (`bg-surface`, `bg-panel`, `border-border`, `text-muted`,
    `text-accent`, `bg-accent-soft`, `bg-danger-soft`, `bg-success-soft`, `bg-warning-soft`). No color values, no `dark:`
    colors: the tokens follow the theme.
  - Global classes, one look everywhere: `card` (surface, border, radius, padding, accent line; add layout utilities,
    `p-3` for a dense one), `badge` with a tone `badge-info|success|warning|danger` (a state in one word, with a dot) and
    `icon-tile` (a square holding one icon). Do not hand-write the box recipe `rounded-lg border border-border bg-surface p-4`.
    Also `seg` (a segmented control; the current link has `aria-current`), `stats` > `stat` with `stat-label`, `stat-value`
    and `stat-sub` (a figure; `--stat-tone` colours it, `--stat-line` sets its top line), `notice` (a banner: warning by
    default, `notice-info`, `notice-error`) and `data-table` inside `table-scroll` (a table of records; `right` and `num` on
    cells). The forms kit: `btn` (`btn-primary`, `btn-sm`), `input` (on every input, select and textarea), `field` with
    `field-label`, `field-help` and `field-error`, `form`, `form-grid`, `form-actions`; also `detail-list` (label and value
    pairs) and `notice-success`. Use them in markup; never rebuild them.
  - The style is closed: a module's stylesheet never names a platform class and never redefines one. Whatever it adds is
    its own, in `modules/<id>/web/<id>.css`, with every selector under its root class or prefix and colour values only in
    custom properties. `tests/styles` in the modules repository fails otherwise.
  - Spacing and shape are variables with the platform's value as default: `--layout-gap`, `--card-pad`, `--card-gap`,
    `--card-radius`, `--card-line-opacity` (`0` removes the accent line). To differ, set them once on the module's page
    root; do not restyle the global classes.
  - Own CSS only for what the platform lacks (charts, a tool's colors): import it from the page, prefix every class with
    the module's short name, scope it under one root class, and build it from the tokens so it follows the theme.
  - English copy, one concern per screen (tabs or on-demand panels, not a stack of sections).
- Code, comments, UI text and commits are in English.
- Be honest about the limit: `getDb` is a contract for well-behaved modules, not a sandbox. A module runs inside the
  platform with its credentials, so install only packages whose source you trust.

## Check before saying it works

`npm run modunexo -- modules pack ...` exits 0, the module installs, its page renders with real data, and a second
module that lists the first in `dependsOn` can read it and cannot write to it. Toggle the theme on the module's page: it
must read well in light and dark with no value of its own. The modules repository's `tests/styles` fails on a hand-written
card or a hard-coded color.
