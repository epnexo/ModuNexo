-- A person's own custom CSS: the text they wrote in Settings > Appearance, kept as typed so they can edit it. It is checked when
-- it is written and again every time it is served (see `sanitizeCustomCss`), so what is in this table is never served as text.
-- One row per person; it goes with the person. The size is capped in the table as well as in the check, so a write that skipped the
-- check still cannot fill the database.

create table core.user_custom_css (
  user_id    text        not null primary key references core.auth_user ("id") on delete cascade,
  css        text        not null check (octet_length(css) <= 16384),
  updated_at timestamptz not null default now()
);
