-- Core bootstrap. The runner creates the `core` schema and, on a fresh database, runs this file
-- before the tracking table exists, so every statement here is idempotent (`if not exists`).
-- The runner records this very file in core.schema_migrations right after it succeeds.
-- Lifecycle state and the audit log arrive with later core migrations.

create table if not exists core.schema_migrations (
  module_id  text        not null,
  filename   text        not null,
  checksum   text        not null,
  applied_at timestamptz not null default now(),
  primary key (module_id, filename)
);
