create table contacts (
  id bigserial primary key,
  channel text not null,
  ref text not null,
  name text,
  created_at timestamptz not null default now(),
  unique (channel, ref)
);

create table conversations (
  id bigserial primary key,
  channel text not null,
  thread_ref text not null,
  contact_id bigint not null references contacts (id),
  unread_count integer not null default 0 check (unread_count >= 0),
  last_message_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (channel, thread_ref)
);

create index conversations_last_message_idx on conversations (last_message_at desc);

create table messages (
  id bigserial primary key,
  conversation_id bigint not null references conversations (id) on delete cascade,
  channel text not null,
  direction text not null check (direction in ('in', 'out')),
  text text not null,
  status text not null check (status in ('received', 'queued', 'sent', 'failed')),
  provider_message_id text,
  error text,
  created_at timestamptz not null default now()
);

create index messages_conversation_idx on messages (conversation_id, id);

-- The provider's own id makes a repeated delivery harmless; outbound messages have none until a provider assigns one.
create unique index messages_provider_id_key on messages (channel, provider_message_id) where provider_message_id is not null;
