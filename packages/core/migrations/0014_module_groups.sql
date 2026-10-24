-- Menu groups: titled blocks of the sidebar that an administrator manages from the front, and the group each
-- installed module sits in. A module with no group keeps whatever group its manifest declares (nav.group), if any.
-- Deleting a group never touches a module: its modules simply have no group again.

create table core.module_groups (
  id         bigint      generated always as identity primary key,
  name       text        not null check (char_length(name) between 1 and 40),
  position   integer     not null,
  created_at timestamptz not null default now()
);

create unique index module_groups_name_idx on core.module_groups (lower(name));

alter table core.modules
  add column group_id bigint references core.module_groups (id) on delete set null;

create index modules_group_idx on core.modules (group_id);
