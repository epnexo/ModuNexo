-- Module lifecycle: which modules are installed, in which state, and an audit log of every transition.
-- A module that is merely available (its package is on disk, nothing was installed) has no row in
-- core.modules. Nothing the manifest already says (name, schema, dependencies) is stored here.

create table core.modules (
  id                text        primary key,
  state             text        not null check (state in ('enabled', 'disabled')),
  installed_version text        not null,
  installed_at      timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Append-only: rows are only ever inserted. There is deliberately no foreign key to core.modules, so the
-- history of a module outlives its uninstall. `detail` is the error message of a failed action (prefixed
-- by the step that failed), or `keep` / `purge` for an uninstall.
create table core.module_events (
  id          bigint      generated always as identity primary key,
  module_id   text        not null,
  action      text        not null check (action in ('install', 'enable', 'disable', 'upgrade', 'uninstall')),
  from_state  text        not null check (from_state in ('available', 'enabled', 'disabled')),
  to_state    text        not null check (to_state in ('available', 'enabled', 'disabled')),
  version     text        not null,
  outcome     text        not null check (outcome in ('ok', 'failed')),
  detail      text,
  occurred_at timestamptz not null default now()
);

create index module_events_module_idx on core.module_events (module_id, id);
