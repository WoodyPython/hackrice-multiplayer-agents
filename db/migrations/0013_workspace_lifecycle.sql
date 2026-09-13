-- Workspace lifecycle: activity, archiving, visits, and a deletion path.
--
-- 0012 made a workspace something an account belongs to. This makes it
-- something an account can find again, put away, and get rid of.
--
-- Three problems it solves, all of which were real before it:
--
-- 1. Nothing recorded when a workspace was last *used*, so "your workspaces"
--    could only be sorted alphabetically. A list of teams ordered by name is a
--    list nobody can scan.
-- 2. `workspaces.status` has existed since 0001 with no route that ever set it
--    ("dead column", handoff-b08). Archiving is what it was for.
-- 3. Nothing could be deleted at all. Every abandoned workspace and every run's
--    worth of events stayed forever, on a 500 MB free-tier database.

-- ---------------------------------------------------------------------------
-- workspaces: when was this last actually used, and when was it put away
-- ---------------------------------------------------------------------------

-- Touched by `appendEvent`, throttled, so it costs one narrow UPDATE per five
-- minutes of activity rather than one per event. Backfilled from the newest
-- task event, falling back to creation, so existing rows sort sensibly on the
-- first deploy instead of all landing at "now".
alter table workspaces add column last_activity_at timestamptz not null default now();

update workspaces w set last_activity_at = greatest(
  w.created_at,
  coalesce((select max(e.created_at) from task_events e where e.workspace_id = w.id), w.created_at)
);

-- Set together with `status`, and the reason both exist: `status` is what the
-- rest of the app reads, `archived_at` is when, which retention needs. Keeping
-- the timestamp only would make every read compute the state.
alter table workspaces add column archived_at timestamptz;

-- Retention and the switcher both order by activity within a status.
create index workspaces_activity_idx on workspaces (status, last_activity_at desc);

-- ---------------------------------------------------------------------------
-- workspace_visits
-- ---------------------------------------------------------------------------
-- "Workspaces I have the link to", which is not the same set as "workspaces I
-- belong to" and could not be recovered before: a link holder who lost the URL
-- lost the workspace, account or no account.
--
-- Deliberately NOT a membership. A row here grants nothing -- authorization
-- reads `workspace_members` and only that. This is one person's own history of
-- what they opened, which is why it is private to them (see RLS below) and why
-- it is written for members and non-members alike.
create table workspace_visits (
  user_id       uuid not null references users (id) on delete cascade,
  workspace_id  uuid not null references workspaces (id) on delete cascade,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  primary key (user_id, workspace_id)
);

-- The read is always "everything this person has opened, most recent first".
create index workspace_visits_recent_idx on workspace_visits (user_id, last_seen_at desc);

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
-- 0004 enabled RLS on the tables that existed then and nothing inherits it.
-- This table is a per-account browsing history keyed to `users`, so it is
-- exactly the kind of table PostgREST must not expose to `anon`.
--
-- RLS on with zero policies denies every role that is neither the table owner
-- nor BYPASSRLS. The Node API connects as the owner and is unaffected.
alter table public.workspace_visits enable row level security;

do $$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.workspace_visits from %I', r);
    end if;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- A note on deletion, since the obvious worry turned out to be unfounded
-- ---------------------------------------------------------------------------
-- Deleting a workspace relies entirely on ON DELETE CASCADE, and `tasks` and
-- `materials` are the only tables referencing `workspaces` directly; everything
-- else hangs off those.
--
-- The one FK in 0002 that is not a cascade looked like it would break this:
-- `agent_questions.answer_entry_id` references `discussion_entries` ON DELETE
-- RESTRICT, and RESTRICT is documented as not deferrable, so it appeared that
-- deleting a workspace where an agent question had been answered would be
-- refused -- the referenced answer being removed while a question still cites
-- it. It is not. Postgres's cascade removes the `agent_questions` row (through
-- runs, then agent_instances) before the RESTRICT check on the entry runs, for
-- both `delete from workspaces` and `delete from tasks`; both were tried
-- directly against this schema.
--
-- So the constraint is left exactly as 0002 wrote it. It still does its real
-- job -- refusing to delete an answer out from under a question that is
-- otherwise staying -- and `workspace-lifecycle.test.ts` covers the cascade so
-- that a future change to it fails a test rather than a deletion.
