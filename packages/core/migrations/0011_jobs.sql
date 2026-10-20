-- The queue of background jobs. A row is one run of a job a module declared. A worker claims due rows with
-- `for update skip locked`, so several workers can run side by side; while a row is `running` it holds a lease, and a
-- row whose lease ran out belongs to a worker that died, so it is given back. A finished row stays for a while so the
-- list can say what happened, and the worker prunes old ones.
--
-- `dedupe_key` keeps one active row per key (module and job name): a module's own keys, and the reserved key
-- '~schedule' that the worker uses to hold the single next run of a job that repeats.

create table core.jobs (
  id              bigserial   primary key,
  module_id       text        not null,
  name            text        not null,
  payload         jsonb,
  status          text        not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'dead', 'cancelled')),
  run_at          timestamptz not null default now(),
  attempts        integer     not null default 0 check (attempts >= 0),
  max_attempts    integer     not null check (max_attempts between 1 and 20),
  timeout_seconds integer     not null check (timeout_seconds between 1 and 3600),
  lease_until     timestamptz,
  locked_by       text,
  last_error      text,
  dedupe_key      text,
  enqueued_by     text        not null,
  created_at      timestamptz not null default now(),
  started_at      timestamptz,
  finished_at     timestamptz,
  check ((status = 'running') = (lease_until is not null)),
  check ((status = 'running') = (locked_by is not null)),
  check ((status in ('succeeded', 'dead', 'cancelled')) = (finished_at is not null))
);

create index jobs_due_idx on core.jobs (run_at, id) where status = 'queued';
create unique index jobs_active_dedupe on core.jobs (module_id, name, dedupe_key) where dedupe_key is not null and status in ('queued', 'running');
create index jobs_module_idx on core.jobs (module_id, id desc);
create index jobs_finished_idx on core.jobs (finished_at) where finished_at is not null;
