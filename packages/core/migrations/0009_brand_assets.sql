-- The logo of a business, or the photo of a person, shown by the shell in place of its default name. The profile
-- text lives in core.platform_settings (key brand.profile); the image is bytes, so it has its own table. One
-- image per kind of asset, replaced in place.

create table core.brand_assets (
  kind         text primary key check (kind in ('logo')),
  content_type text not null check (content_type in ('image/png', 'image/jpeg', 'image/webp')),
  bytes        bytea not null check (octet_length(bytes) between 1 and 524288),
  sha256       text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  updated_at   timestamptz not null default now(),
  updated_by   text not null
);
