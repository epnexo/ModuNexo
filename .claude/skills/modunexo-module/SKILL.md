---
name: modunexo-module
description: "Create, extend or upgrade a custom module for the modunexo platform: generate it, give it data, relate it to other modules, pack and install it. Trigger: creating or changing a module under modules-src/, a manifest.ts, a module migration, or a module page."
license: Apache-2.0
metadata:
  version: "1.0"
---

## When to use

The user wants a new module (documents, contacts, anything), a change to one, or to connect two modules. The platform
(this repository) stays as it is; a module is a separate package that is generated, packed and installed.

## Steps

1. **Decide the shape before generating.** One module is one concern. Pick the `id` (kebab-case, also the folder and
   the URL), what data it owns (its own Postgres schema, named after the id with `_`), and which other modules it must
   read. Ask the user only for what you cannot infer.
2. **Generate.** `npm run modunexo -- modules new <id> --name "<Name>"` writes `modules-src/<id>/` (manifest, a first
   migration, a page that lists and adds rows with `getDb`). Edit that folder; do not copy another module.
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
- UI: reuse the shell's tokens and classes (`bg-surface`, `border-border`, `text-muted`, `bg-accent`), English copy,
  one concern per screen (tabs or on-demand panels, not a stack of sections).
- Code, comments, UI text and commits are in English.
- Be honest about the limit: `getDb` is a contract for well-behaved modules, not a sandbox. A module runs inside the
  platform with its credentials, so install only packages whose source you trust.

## Check before saying it works

`npm run modunexo -- modules pack ...` exits 0, the module installs, its page renders with real data, and a second
module that lists the first in `dependsOn` can read it and cannot write to it.
