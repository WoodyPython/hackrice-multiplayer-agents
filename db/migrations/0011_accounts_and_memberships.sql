-- Accounts, workspace membership, and invitations.
--
-- This replaces guest mode as the basis for authorization. Identity is owned by
-- Supabase Auth; everything here is the part Supabase cannot answer: which
-- workspaces a person belongs to and what they may do inside one.
--
-- The owner key is not deleted. It stays as the ONLY proof that can convert an
-- existing guest workspace into an owned one, because possession of the key is
-- what ownership already meant (design section 1.2) and a workspace URL is not
-- evidence of anything. Once claimed, the hash is cleared so the key cannot be
-- replayed by anyone who saw it earlier.

create type workspace_role as enum ('owner', 'member');

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
-- One row per Supabase account we have seen. `supabase_user_id` is the join
-- key to the provider; email is stored for invitation matching and display and
-- is refreshed on each sign-in, because the provider owns it, not us.
create table users (
  id                uuid primary key default gen_random_uuid(),
  supabase_user_id  uuid not null unique,
  email             text not null check (char_length(btrim(email)) between 3 and 320),
  display_name      text not null check (char_length(btrim(display_name)) between 1 and 80),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
-- Case-insensitive: invitations are matched by email and "Ada@x.com" and
-- "ada@x.com" are the same person to every mail server that will deliver them.
create unique index users_email_uq on users (lower(btrim(email)));

-- ---------------------------------------------------------------------------
-- sessions
-- ---------------------------------------------------------------------------
-- Our own opaque session, not the provider's JWT.
--
-- Three reasons this exists rather than passing the Supabase token around:
-- it is revocable (a JWT is not until it expires), it is carried by a cookie so
-- EventSource and WebSocket upgrades authenticate the same way `fetch` does,
-- and the provider token never has to be persisted in the browser.
--
-- Only the hash is stored. A database disclosure must not hand out live
-- sessions, exactly as with the owner key.
create table sessions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users (id) on delete cascade,
  token_hash    bytea not null unique check (octet_length(token_hash) = 32),
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  expires_at    timestamptz not null
);
create index sessions_user_idx on sessions (user_id);
create index sessions_expiry_idx on sessions (expires_at);

-- ---------------------------------------------------------------------------
-- workspace_members
-- ---------------------------------------------------------------------------
create table workspace_members (
  workspace_id  uuid not null references workspaces (id) on delete cascade,
  user_id       uuid not null references users (id) on delete cascade,
  role          workspace_role not null default 'member',
  created_at    timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
-- The sidebar switcher reads "every workspace I belong to", so this index is on
-- the user, not the workspace.
create index workspace_members_user_idx on workspace_members (user_id);

-- A workspace must never become ownerless: the last owner cannot be demoted or
-- removed. Enforced in application code under a row lock; this partial index
-- makes the "how many owners are left" check cheap.
create index workspace_members_owner_idx
  on workspace_members (workspace_id)
  where role = 'owner';

-- ---------------------------------------------------------------------------
-- workspace_invitations
-- ---------------------------------------------------------------------------
-- Single-use, expiring, hashed at rest. The token is the credential; the
-- workspace URL still grants nothing.
create table workspace_invitations (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces (id) on delete cascade,
  role          workspace_role not null default 'member',
  -- Optional. When set, only this address may accept, which makes an invite
  -- that leaks useless to whoever found it.
  email         text check (char_length(btrim(email)) between 3 and 320),
  token_hash    bytea not null unique check (octet_length(token_hash) = 32),
  invited_by    uuid references users (id) on delete set null,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  accepted_at   timestamptz,
  accepted_by   uuid references users (id) on delete set null,
  revoked_at    timestamptz,
  -- An invitation is consumed or revoked exactly once, never both.
  check (accepted_at is null or revoked_at is null),
  check ((accepted_at is null) = (accepted_by is null))
);
create index workspace_invitations_workspace_idx on workspace_invitations (workspace_id);

-- ---------------------------------------------------------------------------
-- user_preferences
-- ---------------------------------------------------------------------------
-- Per-account settings that used to live only in browser storage, so they
-- follow a person between devices. Deliberately a narrow, closed set: this is
-- not a place to accumulate arbitrary client state.
create table user_preferences (
  user_id        uuid primary key references users (id) on delete cascade,
  theme          text not null default 'system' check (theme in ('system', 'light', 'dark')),
  -- Where "open my last workspace" should land. Cleared by the delete cascade
  -- if that workspace disappears.
  last_workspace uuid references workspaces (id) on delete set null,
  updated_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- workspaces: owner key becomes the migration path, not the permission
-- ---------------------------------------------------------------------------
-- Nullable from here on. A workspace created by a signed-in account has no
-- owner key at all; a pre-existing one keeps its hash until somebody claims it.
alter table workspaces alter column owner_key_hash drop not null;
alter table workspaces add column claimed_at timestamptz;

-- Rows that predate accounts. Kept so the claim endpoint can tell "this
-- workspace is waiting to be claimed" from "this workspace has owners".
comment on column workspaces.owner_key_hash is
  'Legacy guest ownership proof. Present only until the workspace is claimed by an account, then cleared.';
