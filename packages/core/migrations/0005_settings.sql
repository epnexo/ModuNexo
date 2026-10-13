-- Settings that modules declare in their manifests, and an audit trail of who changed them.
--
-- A row holds exactly one of a plain value (jsonb) and an encrypted secret (text, see settings/crypto.ts), so a
-- secret can never sit next to a readable copy of itself. Platform-level settings (appearance, sign-in) live in
-- core.platform_settings.
--
-- core.settings_events never holds a value, plain or secret: only which setting changed, how, who and when. It is
-- deliberately not tied to core.module_settings, so the trail outlives a purged module.

create table core.module_settings (
  module_id  text        not null,
  key        text        not null,
  value      jsonb,
  secret     text,
  updated_at timestamptz not null default now(),
  updated_by text        not null,
  primary key (module_id, key),
  check ((value is null) <> (secret is null))
);

create table core.settings_events (
  id          bigserial   primary key,
  scope       text        not null,
  key         text        not null,
  action      text        not null check (action in ('set', 'unset')),
  actor       text        not null,
  occurred_at timestamptz not null default now()
);

create index settings_events_scope_idx on core.settings_events (scope, occurred_at desc);
