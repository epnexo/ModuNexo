-- Authentication tables, owned by the Better Auth library and created here so the core's migration runner is the
-- only thing that changes the database. The column names and types are the ones the library expects (it queries
-- them by these exact camelCase names); a test compares this file with the library's own plan, so a library
-- upgrade that needs a schema change fails that test instead of failing at sign-in.
--
-- auth_user, auth_session, auth_account and auth_verification are the library's base tables. role, banned,
-- banReason, banExpires and impersonatedBy belong to its admin plugin. auth_rate_limit holds the sign-in throttle.

create table core.auth_user (
  "id"            text        not null primary key,
  "name"          text        not null,
  "email"         text        not null unique,
  "emailVerified" boolean     not null,
  "image"         text,
  "createdAt"     timestamptz not null default current_timestamp,
  "updatedAt"     timestamptz not null default current_timestamp,
  "role"          text,
  "banned"        boolean,
  "banReason"     text,
  "banExpires"    timestamptz
);

create table core.auth_session (
  "id"             text        not null primary key,
  "expiresAt"      timestamptz not null,
  "token"          text        not null unique,
  "createdAt"      timestamptz not null default current_timestamp,
  "updatedAt"      timestamptz not null,
  "ipAddress"      text,
  "userAgent"      text,
  "userId"         text        not null references core.auth_user ("id") on delete cascade,
  "impersonatedBy" text
);

create table core.auth_account (
  "id"                    text        not null primary key,
  "accountId"             text        not null,
  "providerId"            text        not null,
  "userId"                text        not null references core.auth_user ("id") on delete cascade,
  "accessToken"           text,
  "refreshToken"          text,
  "idToken"               text,
  "accessTokenExpiresAt"  timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  "scope"                 text,
  "password"              text,
  "createdAt"             timestamptz not null default current_timestamp,
  "updatedAt"             timestamptz not null
);

create table core.auth_verification (
  "id"         text        not null primary key,
  "identifier" text        not null,
  "value"      text        not null,
  "expiresAt"  timestamptz not null,
  "createdAt"  timestamptz not null default current_timestamp,
  "updatedAt"  timestamptz not null default current_timestamp
);

create table core.auth_rate_limit (
  "id"          text    not null primary key,
  "key"         text    not null unique,
  "count"       integer not null,
  "lastRequest" bigint  not null
);

create index "auth_session_userId_idx" on core.auth_session ("userId");
create index "auth_account_userId_idx" on core.auth_account ("userId");
create index "auth_verification_identifier_idx" on core.auth_verification ("identifier");
