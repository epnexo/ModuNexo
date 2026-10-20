# Feature: file and attachment API (ADR-001, capability 5)

Objective: a module stores, reads and deletes files through the SDK without touching the disk itself; the bytes sit behind a storage adapter (disk first, object storage later); a signed-in browser downloads them through a gated route.
Branch: feat/files-attachments (from main). Delivery strategy: ask-on-risk; the owner wants only `main` on GitHub, so the branch stays local and is fast-forwarded into `main`; no push without the owner. Test runner: `npm test` (node:test via tsx), `npm run typecheck`.

## Specs

- S1. Manifest: `files: { maxBytes?, accept?, permission? }` opts the module in. `maxBytes` is a positive integer, at most the
  platform ceiling of 50 MiB (default 10 MiB). `accept` is a list of up to 20 content types (`image/png`) or families (`image/*`) the module takes (default: any). `permission`, when present, is one of the module's declared permissions; a file is downloaded by a
  browser only by a viewer who holds it. Without `permission` a file is never sent to a browser. Unknown fields are refused.
  A module without `files` cannot store files. [decision]
- S2. Adapter: a `FileStorage` interface (`put`, `open`, `remove`, `exists`) is the only code that touches bytes. The platform
  ships `DiskStorage`, rooted at `<data dir>/files`, laid out `<module>/<aa>/<id>`; a key never comes from user input.
  Choosing another adapter later changes no module. [decision]
- S3. Storage of metadata: `core.files` holds one row per file: uuid `id`, `module_id`, display `name`, sniffed `content_type`,
  `size`, `sha256`, optional module-defined `ref` (at most 200 characters, to find "the files of message 42"), `created_at`.
  [decision]
- S4. Store: the SDK exports `putFile(moduleId, { name, data, ref? }, { tx? })`. `data` is bytes or a stream; it is
  written to a temporary file while the size is counted and the SHA-256 is computed, and refused (`FileError`) past the
  module's limit, with an empty body, or when the content type is not accepted. The content type is decided from the first
  bytes (png, jpeg, gif, webp, pdf, zip, gzip, plain text, else `application/octet-stream`), never from the name or from
  anything the caller declares. With `tx` the row is written in the caller's transaction. It
  resolves to the file's metadata. [decision]
- S5. Names: the stored display name is reduced to a safe single path segment (no separators, no control characters, at most
  200 characters, never empty or dot-only). Nothing in a path or header comes from the name. [decision]
- S6. Read: `getFile(moduleId, id)` resolves to `{ meta, stream }` or `null`; `statFile`, `listFiles(moduleId, { ref?, limit? })`
  and `deleteFile(moduleId, id)` complete the set. A module sees and deletes only its own files; another module's id answers
  `null`/`false`. Deleting removes the row and then the bytes. [decision]
- S7. Download: `GET /api/files/<module>/<id>` answers the bytes to a signed-in viewer who holds the module's `files.permission`
  (admin, operator and the local operator hold all module permissions). It sends the stored content type,
  `Content-Disposition: attachment` with a safe file name, `X-Content-Type-Options: nosniff` and
  `Content-Security-Policy: default-src 'none'; sandbox`. 404 for an unknown or foreign file, 403 without the permission,
  and the same 404 when the module is disabled. [decision]
- S8. Orphans: a crash between writing the bytes and the row, or a failed delete, leaves bytes without a row. The worker removes,
  hourly, bytes older than one day that have no row; temporary files older than one hour go too. [decision]
- S9. Lifecycle: `uninstall --purge` deletes the module's rows and its directory of bytes. The install review lists whether the
  module stores files and its limit. Backup and restore scripts include the files directory.
- S10. CLI: `files list [module] [--limit <n>] [--json]` and `files delete <module> <id>`. Refusals exit 3, usage errors exit 2.
- S11. Docs: README, the module skill, an ADR note.
- Not in this feature (follow-ups): an object-storage adapter; image thumbnails; a virus scan hook; per-module quotas on the
  total; signed temporary download links for outside callers; a browser upload route owned by the platform.

## Tasks

- [ ] T1 (S1, S4-S6 SDK side) manifest `files`, `files.ts` (types, symbol, `putFile`/`getFile`/`statFile`/`listFiles`/`deleteFile`). Route: inline.
- [ ] T2 (S2, S3, S4, S5, S6, S9 purge) migration 0013, `FileStorage`, `DiskStorage`, `FileService`, content sniffing, purge. Route: inline.
- [ ] T3 (S8, S9, S10) register the service in web and worker, orphan sweep, purge of bytes on uninstall, CLI `files`, backup scripts. Route: inline.
- [ ] T4 (S7) download route, gate, end-to-end. Route: inline.
- [ ] T5 (S9 review, S11) install review, README, skill, ADR note. Route: inline.
- [ ] T6 full suite, independent verifier. Route: inline then verifier.

## Log

- L1 (2026-10-21, user, verbatim): "sí, sigue con la 5"
- L2: Route declaration: all tasks inline; no writer trigger (tasks share SDK, core, CLI and web files). Mapping trigger fired once
  (explorer: data dir, backup scripts, body readers, gate, SDK symbols, purge, worker prune). Risk: security (item 2: a
  permission decides who downloads, a sniffed type decides what a browser may run, a name must never reach a path), data
  (item 1: bytes on disk outside the database, deleted on purge) and a new persisted table (additive), so an independent
  verifier runs at the end.
- L3: Decisions taken without asking, per the standing instruction: the adapter is a small interface with a disk
  implementation; metadata lives in Postgres and bytes elsewhere, so the orphan sweep is the price of not having a
  distributed transaction; a browser sees a file only if the manifest ties it to a permission (same fail-closed rule as events);
  the platform offers no upload route, a module's own route reads its body and calls `putFile` (the platform has no
  multipart parser and a module decides its own protocol); downloads are always `attachment`.
- L4: Facts from the map: the data dir is `MODUNEXO_DATA_DIR` (default `<repo>/var`, volume `epnexo-data` at `/app/var` in web
  and worker); the brand logo is a `bytea`, not a file; `backup.sh`/`restore.sh` cover only the dump, modules and packages,
  so the files directory needs lines in both; `sniffImage` in `brand.ts` is the only content sniffer; `readBodyBytes`
  buffers while `receiveUpload` streams with a cap.
- L5: Refinement while writing the SDK tests: `putFile` takes no declared content type (a caller's claim is never stored); the
  type is sniffed from the bytes, and `accept` filters on that type.
