-- B01: enum types.
-- Every value here is mirrored in packages/contracts/src/enums.ts. If you add a
-- value, add it in both places in the same commit.

create extension if not exists pgcrypto;

create type workspace_status as enum ('active', 'archived');

create type task_kind as enum ('agent_task', 'manual_edit');

-- Design section 2.4, in lifecycle order.
-- Terminal states are exactly ('completed', 'canceled'). 'incomplete' and
-- 'interrupted' are NOT terminal: section 2.4 offers manual retry from both.
create type task_status as enum (
  'posted',
  'planning',
  'working',
  'needs_input',
  'ready_for_review',
  'conflict',
  'incomplete',
  'interrupted',
  'canceled',
  'completed'
);

-- A run is one execution attempt. It carries the execution half of the task
-- lifecycle; review/conflict states belong to the task, not the attempt.
-- Active statuses are ('planning', 'working', 'needs_input') and are what the
-- unique-active-run index keys on.
create type run_status as enum (
  'planning',
  'working',
  'needs_input',
  'completed',
  'incomplete',
  'interrupted',
  'canceled'
);

-- Design section 2.4, agent states.
create type agent_status as enum (
  'pending',
  'running',
  'needs_input',
  'completed',
  'failed',
  'timed_out',
  'token_exhausted',
  'canceled',
  'interrupted'
);

-- Design section 8.2.
create type agent_preset as enum (
  'orchestrator',
  'analyst',
  'writer',
  'coder',
  'reviewer'
);

create type actor_type as enum ('guest', 'agent', 'system');

-- Design section 2.6.
create type question_status as enum ('open', 'answered', 'expired', 'canceled');

create type draft_status as enum ('active', 'closed');

create type review_status as enum (
  'building',
  'ready',
  'stale',
  'conflict',
  'applied',
  'superseded'
);

create type apply_status as enum ('pending', 'applied', 'failed', 'ambiguous');

create type model_call_status as enum ('reserved', 'reported', 'failed', 'unknown');
