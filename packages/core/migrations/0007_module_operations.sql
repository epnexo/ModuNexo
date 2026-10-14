-- Every run of the install pipeline: which package, what it was doing, how it ended. A run is updated as it goes,
-- so a screen can show progress, and it is never deleted. At most one run is `running` at a time (the unique
-- index below), which is the pipeline's lock; a run whose process died is marked failed by the next start.

create table core.module_operations (
  id          bigserial   primary key,
  module_id   text        not null,
  version     text        not null,
  sha256      text        not null check (sha256 ~ '^[0-9a-f]{64}$'),
  kind        text        not null check (kind in ('install', 'upgrade')),
  status      text        not null default 'running' check (status in ('running', 'succeeded', 'failed', 'rolled_back')),
  step        text        not null default 'start',
  detail      text,
  actor       text        not null,
  pid         integer     not null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  check ((status = 'running') = (finished_at is null))
);

create unique index module_operations_one_running on core.module_operations ((true)) where status = 'running';
create index module_operations_module_idx on core.module_operations (module_id, started_at desc);
