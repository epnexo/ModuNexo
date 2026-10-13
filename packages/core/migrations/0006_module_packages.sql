-- Every module package that reached the platform, accepted or refused. This is the record of what was received
-- before anything is installed: who sent it, when, how big, and its SHA-256, which names the archive on disk
-- (var/packages/<sha256>.tgz) and the unpacked staging tree (var/staging/<sha256>/).
--
-- A refusal keeps its reasons, a staged package does not carry any, and module_id/version are null when the
-- package was refused before its manifest could be read.

create table core.module_packages (
  id          bigserial   primary key,
  sha256      text        not null check (sha256 ~ '^[0-9a-f]{64}$'),
  module_id   text,
  version     text,
  size_bytes  bigint      not null check (size_bytes >= 0),
  status      text        not null check (status in ('staged', 'refused')),
  problems    jsonb,
  actor       text        not null,
  received_at timestamptz not null default now(),
  check ((status = 'refused') = (problems is not null))
);

create index module_packages_sha256_idx on core.module_packages (sha256);
create index module_packages_module_idx on core.module_packages (module_id, received_at desc);
