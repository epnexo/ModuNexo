-- The log of events modules publish. A row is one fact a module announced, written in the same transaction as the data
-- it describes. `id` is the position in the log: publishers take an advisory lock before the id is assigned, so ids
-- become visible in order and a reader that remembers the last id it saw cannot skip one. A browser resumes after an id;
-- the worker deletes old rows, so a cursor older than the oldest row is told to start over.

create table core.events (
  id         bigserial   primary key,
  module_id  text        not null,
  type       text        not null check (char_length(type) between 3 and 200),
  payload    jsonb,
  created_at timestamptz not null default now()
);

create index events_module_idx on core.events (module_id, id desc);
create index events_created_idx on core.events (created_at);
