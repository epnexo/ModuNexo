-- What a module's own database login may do in `core`: publish an event, queue a job, record a file, each through a
-- SECURITY DEFINER function that takes the module from `session_user` (the login the connection was opened with,
-- which SQL cannot change), never from an argument. The platform keeps two tables up to date from the manifests so the
-- database can apply the rules itself: the jobs a module declares, the events it may publish and who subscribes to
-- which event.

create table core.module_jobs (
  module_id       text    not null,
  name            text    not null,
  max_attempts    integer not null check (max_attempts between 1 and 20),
  timeout_seconds integer not null check (timeout_seconds between 1 and 3600),
  primary key (module_id, name)
);

create table core.module_declared_events (
  module_id text not null,
  name      text not null,
  primary key (module_id, name)
);

create table core.event_subscriptions (
  subscriber_module text not null,
  event_type        text not null,
  job_name          text not null,
  primary key (subscriber_module, event_type, job_name)
);

create index event_subscriptions_type_idx on core.event_subscriptions (event_type);

-- The module behind the login of this connection, which must be enabled. Internal: nobody but the functions below calls it.
create function core.caller_module() returns text
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_module text;
begin
  select module_id into v_module from core.module_roles where role_name = session_user;
  if v_module is null then
    raise exception '% is not a module login', session_user using errcode = '42501';
  end if;
  if not exists (select 1 from core.modules where id = v_module and state = 'enabled') then
    raise exception 'module "%" is not enabled', v_module;
  end if;
  return v_module;
end;
$$;

create function core.publish_event(p_name text, p_payload jsonb) returns bigint
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_module  text := core.caller_module();
  v_type    text := v_module || '.' || p_name;
  v_id      bigint;
  v_created timestamptz := now();
begin
  if p_name is null or char_length(p_name) > 100 or p_name !~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$' then
    raise exception 'the event name is not valid';
  end if;
  if not exists (select 1 from core.module_declared_events where module_id = v_module and name = p_name) then
    raise exception 'module "%" does not declare the event "%"', v_module, p_name;
  end if;
  if char_length(v_type) > 200 then
    raise exception 'the event type is over 200 characters';
  end if;
  if octet_length(coalesce(p_payload, 'null'::jsonb)::text) > 16384 then
    raise exception 'the payload is over 16 KiB';
  end if;
  perform pg_advisory_xact_lock(7251041);
  insert into core.events (module_id, type, payload, created_at) values (v_module, v_type, p_payload, v_created) returning id into v_id;

  insert into core.jobs (module_id, name, payload, run_at, max_attempts, timeout_seconds, enqueued_by)
  select s.subscriber_module, s.job_name,
         jsonb_build_object('event', jsonb_build_object('id', v_id, 'type', v_type, 'payload', p_payload,
           'createdAt', to_char(v_created at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))),
         v_created, j.max_attempts, j.timeout_seconds, 'event:' || v_module
  from core.event_subscriptions s
  join core.module_jobs j on j.module_id = s.subscriber_module and j.name = s.job_name
  join core.modules m on m.id = s.subscriber_module and m.state = 'enabled'
  where s.event_type = v_type;

  perform pg_notify('modunexo_events', v_id::text);
  return v_id;
end;
$$;

create function core.enqueue_job(p_name text, p_payload jsonb, p_run_at timestamptz, p_dedupe_key text)
returns table (job_id bigint, deduplicated boolean)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_module text := core.caller_module();
  v_job    core.module_jobs%rowtype;
  v_id     bigint;
begin
  select * into v_job from core.module_jobs where module_id = v_module and name = p_name;
  if not found then
    raise exception 'module "%" does not declare the job "%"', v_module, p_name;
  end if;
  if octet_length(coalesce(p_payload, 'null'::jsonb)::text) > 65536 then
    raise exception 'the payload is over 64 KiB';
  end if;
  if p_run_at is null or p_run_at > now() + interval '30 days' then
    raise exception 'run_at must be at most 30 days ahead';
  end if;
  if p_dedupe_key is not null and p_dedupe_key !~ '^[A-Za-z0-9][A-Za-z0-9:._-]{0,99}$' then
    raise exception 'dedupeKey is not valid';
  end if;
  for i in 1..3 loop
    insert into core.jobs (module_id, name, payload, run_at, max_attempts, timeout_seconds, dedupe_key, enqueued_by)
    values (v_module, p_name, p_payload, p_run_at, v_job.max_attempts, v_job.timeout_seconds, p_dedupe_key, 'module')
    on conflict (module_id, name, dedupe_key) where dedupe_key is not null and status in ('queued', 'running') do nothing
    returning core.jobs.id into v_id;
    if v_id is not null then
      return query select v_id, false;
      return;
    end if;
    select j.id into v_id from core.jobs j
    where j.module_id = v_module and j.name = p_name and j.dedupe_key = p_dedupe_key and j.status in ('queued', 'running');
    if v_id is not null then
      return query select v_id, true;
      return;
    end if;
  end loop;
  raise exception 'could not queue the job: its dedupe key kept changing hands';
end;
$$;

create function core.record_file(p_id uuid, p_name text, p_content_type text, p_size bigint, p_sha256 text, p_ref text, p_created_at timestamptz)
returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_module text := core.caller_module();
begin
  insert into core.files (id, module_id, name, content_type, size, sha256, ref, created_at)
  values (p_id, v_module, p_name, p_content_type, p_size, p_sha256, p_ref, p_created_at);
end;
$$;

revoke all on function core.caller_module() from public;
revoke all on function core.publish_event(text, jsonb) from public;
revoke all on function core.enqueue_job(text, jsonb, timestamptz, text) from public;
revoke all on function core.record_file(uuid, text, text, bigint, text, text, timestamptz) from public;
