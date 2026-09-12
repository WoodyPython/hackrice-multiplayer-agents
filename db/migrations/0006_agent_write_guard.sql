-- B07: agent state transition checks (design section 11.2).
--
-- "Agent state transition checks: a terminal/expired instance cannot write."
--
-- This is the one place the design asks for a database-level transition guard,
-- and the asymmetry with task transitions is deliberate. A task transition
-- always runs inside a request that already holds the task row, so the service
-- layer is sufficient. An agent write can arrive from a detached async context
-- long after the agent was abandoned: section 9.2 says "canceling a local
-- request does not guarantee the provider stopped computation", so a result can
-- land after the deadline, after a cancel, or after a restart marked the
-- instance interrupted. There is no request holding a lock to check.
--
-- Enforced as a trigger rather than a CHECK because it compares the new row to
-- the old one, which CHECK cannot do.

create or replace function agent_instances_guard_writes()
returns trigger
language plpgsql
as $$
declare
  terminal agent_status[] := array[
    'completed', 'failed', 'timed_out', 'token_exhausted', 'canceled', 'interrupted'
  ]::agent_status[];
begin
  if not (old.status = any (terminal)) then
    return new;
  end if;

  -- A terminal instance may still be annotated: recording usage that arrived
  -- late is exactly what section 9.2 asks for ("late usage may still be
  -- recorded"). What it may not do is change its outcome or its work product.
  if new.status is distinct from old.status then
    raise exception
      'agent instance % is % and cannot transition to %',
      old.id, old.status, new.status
      using errcode = 'check_violation',
            constraint = 'agent_instances_terminal_no_transition';
  end if;

  if new.result_sha is distinct from old.result_sha
     or new.base_sha is distinct from old.base_sha
     or new.write_paths is distinct from old.write_paths
     or new.deadline_at is distinct from old.deadline_at then
    raise exception
      'agent instance % is % and cannot write results',
      old.id, old.status
      using errcode = 'check_violation',
            constraint = 'agent_instances_terminal_no_write';
  end if;

  return new;
end;
$$;

create trigger agent_instances_guard_writes
  before update on agent_instances
  for each row
  execute function agent_instances_guard_writes();

-- Reading "is this instance still allowed to write?" happens on every tool call
-- and every integration, so give it an index rather than a sequential scan over
-- a run's instances.
create index agent_instances_live_idx
  on agent_instances (run_id)
  where status in ('pending', 'running', 'needs_input');
