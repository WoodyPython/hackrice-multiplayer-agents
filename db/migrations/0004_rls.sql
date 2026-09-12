-- B01: lock the browser out of the tables (design section 11.4).
--
-- "Disable direct public table access with ordinary database policies.
--  Browser clients do not directly mutate tables or storage objects."
--
-- Mechanism: enable RLS with ZERO policies. Postgres denies everything to any
-- role that is not the table owner and does not have BYPASSRLS. Supabase's
-- PostgREST roles (anon, authenticated) are exactly those roles, so /rest/v1
-- returns nothing for every table. The Node API connects via DATABASE_URL as
-- the owning role and is unaffected.
--
-- Browsers get Realtime Broadcast only, which carries refresh hints and no
-- authority (section 5.1).

do $$
declare
  t record;
begin
  for t in
    select tablename
    from pg_tables
    where schemaname = 'public'
      and tablename <> 'schema_migrations'
  loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;
end
$$;

-- Belt and braces: revoke the grants Supabase hands those roles by default.
-- Guarded by role existence so this migration also runs on plain Postgres
-- (local docker compose, CI), where anon/authenticated do not exist.
do $$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema public from %I', r);
      execute format('revoke all on all sequences in schema public from %I', r);
      execute format('revoke all on all functions in schema public from %I', r);
      execute format(
        'alter default privileges in schema public revoke all on tables from %I', r);
      execute format(
        'alter default privileges in schema public revoke all on sequences from %I', r);
    end if;
  end loop;
end
$$;
