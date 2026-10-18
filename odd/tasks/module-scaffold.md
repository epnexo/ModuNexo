# Module scaffold: data access for modules, a generator, and a skill to build custom modules
Branch: feat/module-scaffold (stacked on feat/security-hardening). Delivery: ask-on-risk. Runner: `node --import tsx --test`, TEST_DATABASE_URL on 127.0.0.1:5436, `npm run typecheck`.

## Specs
- S1. "la idea inicial es crear la base y de hay dar los pasos o skill para crear los modulos y de hay que sea personalizado": the base ships a way to create a module and a skill that walks an author through it. The CRM, documents and the rest are modules built afterwards, not part of this feature.
- S2. "agrégalo, que sea estructurada profesional": the SDK gets `getDb(moduleId)`, registered by the platform under a global symbol exactly like `getSetting` (the SDK holds no database code). The handle is scoped to the module's own schema (`search_path` fixed per query, one transaction per call) and offers `query(sql, params)` and `transaction(fn)`. Outside the running platform it throws a clear `DbUnavailableError`. A module that is not installed and enabled gets a clear refusal.
- S3. "si se puede leer o dar permisos a que el modulo pueda tener relacion con otro sin complicar tanto": a module may read another module's data only if the other module is in its manifest `dependsOn` (already enforced at install). `db.reader("<other>")` returns a READ ONLY handle on that schema (Postgres `READ ONLY` transaction, so a write fails in the database, not by convention). Anything not in `dependsOn` is refused by name. Writes to another module's schema are not offered. This is a platform API contract, not a sandbox: modules still run with full privileges (said in the docs).
- S4. A generator: `npm run epnexo -- modules new <id> [--name <text>] [--dir <parent>]` writes a working module folder (`package.json`, `manifest.ts`, a migration, a page that lists and adds rows with a server action; no hooks file, YAGNI) that uses `getDb`, passes `validateManifest` and `modules pack`, and refuses an invalid id or an existing folder. Exit codes follow the CLI (2 usage, 3 refused).
- S5. A skill `.claude/skills/epnexo-module/SKILL.md` in the repository: the steps to design, generate, test, pack, add and apply a custom module, including cross-module reads, with the rules (English artifacts, one concern per screen, migrations are append-only, version bump on schema change).
- S6. README documents `getDb`, `reader`, the permission rule, `modules new` and the skill; help text updated.
- Not in scope (decided): sandbox or database roles per module, writes across modules, the real CRM/documents modules (next features).

## Tasks
- T1 S2 S3 inline — SDK `db.ts` (types, symbol, `getDb`, errors) + tests — done (RED: module not found; GREEN 3/3)
- T2 S2 S3 inline — core `ModuleDbService` (scoped query/transaction, read-only reader, dependsOn + enabled checks) + Postgres integration tests — done (12 integration tests incl. read-only refusal 25006, one statement per call)
- T3 S2 inline — web registers the reader in `platform.ts` — done (reader registered in platform.ts; typecheck clean)
- T4 S4 inline — `modules new` generator + templates + tests (output validates and packs) — done (RED 5/6 failing, GREEN 6/6; CLI suites 58/58)
- T5 S2 S3 S4 inline — end-to-end: scaffold → pack → add → apply, the page serves data from its own schema; a second module reads the first through `reader`
- T6 S5 S6 inline — skill + README + help text — done (skill + README sections; help text lists modules new)

## Log
- L1 (2026-10-18, owner): "si trabajemos para crear la base y de hay continuamos con los otros como la de documentos y de mas"
- L2 (2026-10-18, owner): "la idea inicial es crear la base y de hay dar los pasos o skill para crear los modulos y de hay que sea personalizado"
- L3 (2026-10-18, owner, answering "¿Agrego `getDb` al SDK…?"): "si agrégalo, que sea estructurada profesional si se puede leer o dar permisos a que el modulo pueda tener relacion con otro sin complicar tanto"
- L4: finding before writing: the SDK header says "a module never reaches the database", so modules had no way to read or write their own tables; `getSetting` is the pattern to copy (global symbol reader registered in apps/web/src/server/platform.ts).
