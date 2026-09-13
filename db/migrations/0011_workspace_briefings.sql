-- "Catch me up" briefings, per workspace and per browser session.
--
-- A row is written only after a successful generation, so the latest row with
-- advances_cutoff is the session's "since last briefing" cutoff. The session
-- key is stored as a sha256 hash, like the owner key: it scopes history and is
-- never a permission credential.
create table workspace_briefings (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references workspaces (id) on delete cascade,
  viewer_hash     bytea not null check (octet_length(viewer_hash) = 32),
  window_mode     text not null check (window_mode in ('since_last', 'last_hour', 'last_24h')),
  window_start    timestamptz not null,
  window_end      timestamptz not null,
  advances_cutoff boolean not null,
  content         jsonb not null,
  created_at      timestamptz not null default now(),

  constraint workspace_briefings_window_ck check (window_start <= window_end)
);

create index workspace_briefings_viewer_idx
  on workspace_briefings (workspace_id, viewer_hash, created_at desc);

-- Same rule as every other application table (0004): browsers never read it.
alter table public.workspace_briefings enable row level security;
