-- Migration metadata is server-only, just like the application tables.
alter table public.schema_migrations enable row level security;

-- Resolve the trigger's agent_status enum from the application schema.
alter function public.agent_instances_guard_writes()
  set search_path = public, pg_temp;
