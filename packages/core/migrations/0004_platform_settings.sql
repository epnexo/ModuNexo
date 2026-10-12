-- Platform-level settings: values that belong to the platform itself, not to a module. The first one is
-- "auth.signIn" (whether the shell asks for a sign-in). Module settings are a separate, later feature.
--
-- updated_by names who made the change ("cli" for the command line); there is no interactive user yet.

create table core.platform_settings (
  key        text        primary key,
  value      jsonb       not null,
  updated_at timestamptz not null default now(),
  updated_by text        not null
);
