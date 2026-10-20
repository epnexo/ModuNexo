-- The files modules store through the SDK. A row describes one file; the bytes live behind the storage adapter (a folder on
-- disk today) under `<module>/<first two characters of id>/<id>`, so the row and the bytes are linked by the id alone.
-- The type is the one the platform sniffed from the bytes, never the one a caller claimed. A crash between writing the bytes
-- and the row leaves bytes without a row; the worker removes those after a day.

create table core.files (
  id           uuid        primary key,
  module_id    text        not null,
  name         text        not null check (char_length(name) between 1 and 200),
  content_type text        not null check (char_length(content_type) between 3 and 127),
  size         bigint      not null check (size > 0),
  sha256       text        not null check (sha256 ~ '^[0-9a-f]{64}$'),
  ref          text        check (char_length(ref) between 1 and 200),
  created_at   timestamptz not null default now()
);

create index files_module_idx on core.files (module_id, created_at desc, id desc);
create index files_ref_idx on core.files (module_id, ref, created_at desc) where ref is not null;
