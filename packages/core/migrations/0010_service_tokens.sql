-- Bearer tokens for machine callers of a module's scoped routes. Only the SHA-256 of a token is stored, so a copy of
-- the database does not carry a usable token; the token itself is shown once, when it is created. `prefix` is the
-- non-secret part of the token that finds the row. A revoked or expired token stays, so the list can say what
-- happened to it.

create table core.service_tokens (
  id           bigserial   primary key,
  module_id    text        not null,
  name         text        not null check (char_length(name) between 1 and 80),
  prefix       text        not null unique check (prefix ~ '^[0-9a-f]{8}$'),
  token_hash   text        not null check (token_hash ~ '^[0-9a-f]{64}$'),
  scopes       text[]      not null check (cardinality(scopes) > 0),
  expires_at   timestamptz,
  revoked_at   timestamptz,
  last_used_at timestamptz,
  created_by   text        not null,
  created_at   timestamptz not null default now()
);

create index service_tokens_module_idx on core.service_tokens (module_id, id);

-- Who created and who revoked which token. No foreign key and no token value, so the trail outlives a purged module
-- and holds nothing worth stealing.
create table core.service_token_events (
  id         bigserial   primary key,
  token_id   bigint      not null,
  module_id  text        not null,
  action     text        not null check (action in ('created', 'revoked')),
  actor      text        not null,
  created_at timestamptz not null default now()
);

create index service_token_events_token_idx on core.service_token_events (token_id, id);
