-- Agent histories: the recorded thought process of each agent instance.
--
-- One row per model turn (thought summary, visible text, tool calls) or per
-- batch of tool results. Written by the execution layer as work happens and
-- read by the History screen once the agent is done. Content is clipped by the
-- application; the size check is a backstop so a trace can never grow a row
-- without bound.
--
-- Ordered by id. Rows are append-only history and are never updated, so they
-- need no terminal-state guard like agent_instances has (0006).
create table agent_trace_steps (
  id                bigint generated always as identity primary key,
  workspace_id      uuid not null,
  task_id           uuid not null,
  run_id            uuid not null,
  agent_instance_id uuid not null,
  kind              text not null check (kind in ('model_turn', 'tool_results')),
  content           jsonb not null,
  created_at        timestamptz not null default now(),

  constraint agent_trace_steps_task_fk
    foreign key (task_id, workspace_id) references tasks (id, workspace_id) on delete cascade,
  constraint agent_trace_steps_agent_fk
    foreign key (agent_instance_id, run_id) references agent_instances (id, run_id) on delete cascade,
  constraint agent_trace_steps_size_ck
    check (octet_length(content::text) <= 262144)
);

create index agent_trace_steps_agent_idx
  on agent_trace_steps (agent_instance_id, id);

-- Same rule as every other application table (0004, 0012): browsers never read
-- it. Traces hold generated reasoning and file excerpts from private workspaces.
alter table public.agent_trace_steps enable row level security;

-- Tables added after 0012 do not inherit its revoke; repeat it, guarded the same
-- way because anon and authenticated exist only on Supabase.
do $$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on table public.agent_trace_steps from %I', r);
      execute format('revoke all on sequence public.agent_trace_steps_id_seq from %I', r);
    end if;
  end loop;
end
$$;
