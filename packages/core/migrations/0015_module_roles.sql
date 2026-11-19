-- Each module gets a Postgres login of its own (see data/module-roles.ts). This table says which module a login
-- belongs to, and `record_migration` lets that login record its own migration in the same transaction as the SQL,
-- without any right on core.schema_migrations.

create table core.module_roles (
  role_name   text primary key,
  module_id   text not null unique,
  schema_name text not null
);

-- SECURITY DEFINER runs as the function's owner, so `current_user` inside it is the owner and says nothing about the
-- caller. The caller is `session_user`: the login the connection was opened with, which SQL cannot change.
create function core.record_migration(p_filename text, p_checksum text) returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_module text;
begin
  select module_id into v_module from core.module_roles where role_name = session_user;
  if v_module is null then
    raise exception 'record_migration: % is not a module login', session_user using errcode = '42501';
  end if;
  insert into core.schema_migrations (module_id, filename, checksum) values (v_module, p_filename, p_checksum);
end;
$$;

revoke all on function core.record_migration(text, text) from public;
