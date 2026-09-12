-- B01: the 18 application tables (design section 11.1).
--
-- Two conventions run through this file and matter for every role:
--
-- 1. Composite uniqueness for scoping. Tables expose `unique (id, <parent>)`
--    so children can carry a composite foreign key. That is what makes
--    "a material from workspace A cannot be attached to workspace B"
--    (section 11.2) a database guarantee rather than an application habit.
--    Same trick binds agents to their run and questions to their task.
--
-- 2. SHA columns are checked against ^[0-9a-f]{40}$. Git object IDs are the
--    freshness tuple (section 10.1); a truncated or prefixed SHA silently
--    breaking a guarded ref update is worth failing loudly on insert.

-- ---------------------------------------------------------------------------
-- workspaces
-- ---------------------------------------------------------------------------
create table workspaces (
  id               uuid primary key default gen_random_uuid(),
  name             text not null check (char_length(btrim(name)) between 1 and 200),
  purpose          text not null default '' check (char_length(purpose) <= 4000),
  -- sha256 of the owner key. The raw key is returned once at creation and
  -- never stored (section 1.2).
  owner_key_hash   bytea not null check (octet_length(owner_key_hash) = 32),
  guidance         text not null default '' check (char_length(guidance) <= 20000),
  guidance_version integer not null default 1 check (guidance_version >= 1),
  status           workspace_status not null default 'active',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- tasks
-- ---------------------------------------------------------------------------
create table tasks (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references workspaces (id) on delete cascade,
  kind                task_kind not null,
  manual_source_path  text check (char_length(manual_source_path) between 1 and 400),
  creator_guest_label text not null check (char_length(btrim(creator_guest_label)) between 1 and 80),
  title               text not null check (char_length(btrim(title)) between 1 and 200),
  outcome             text not null default '' check (char_length(outcome) <= 10000),
  criteria            text[] not null default '{}' check (cardinality(criteria) <= 50),
  output_paths        text[] not null default '{}' check (cardinality(output_paths) <= 50),
  version             integer not null default 1 check (version >= 1),
  status              task_status not null default 'posted',
  -- Points at a run of this same task; the composite FK is added in 0003
  -- once `runs` exists.
  active_run_id       uuid,
  -- Allocator for discussion_entries.seq. Bumped under this row's lock so
  -- sequence order matches commit order and a run cutoff is exact (section 2.3).
  discussion_seq      bigint not null default 0 check (discussion_seq >= 0),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint tasks_manual_path_ck
    check ((kind = 'manual_edit') = (manual_source_path is not null)),
  constraint tasks_id_workspace_uq unique (id, workspace_id)
);

-- ---------------------------------------------------------------------------
-- discussion_entries
-- ---------------------------------------------------------------------------
create table discussion_entries (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null,
  task_id           uuid not null,
  -- Gap-free per-task order. Run cutoffs and client pagination both key on it.
  seq               bigint not null check (seq > 0),
  actor_type        actor_type not null,
  -- Unverified display label (section 1.3). Never a permission credential.
  guest_label       text check (char_length(btrim(guest_label)) between 1 and 80),
  body              text not null check (char_length(body) between 1 and 20000),
  client_request_id text check (char_length(client_request_id) between 1 and 200),
  created_at        timestamptz not null default now(),

  constraint discussion_entries_task_fk
    foreign key (task_id, workspace_id) references tasks (id, workspace_id) on delete cascade,
  constraint discussion_entries_seq_uq unique (task_id, seq),
  constraint discussion_entries_id_task_uq unique (id, task_id),
  constraint discussion_entries_guest_label_ck
    check ((actor_type = 'guest') = (guest_label is not null))
);

-- ---------------------------------------------------------------------------
-- materials
-- ---------------------------------------------------------------------------
create table materials (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces (id) on delete cascade,
  filename     text not null check (char_length(btrim(filename)) between 1 and 400),
  -- Derived from workspace/material IDs, never from the uploaded filename
  -- (section 6.2).
  object_key   text not null unique,
  sha256       bytea not null check (octet_length(sha256) = 32),
  byte_size    bigint not null check (byte_size >= 0),
  content_type text not null default 'application/octet-stream',
  guest_label  text,
  created_at   timestamptz not null default now(),
  -- Soft delete: section 11.5 re-checks material availability at Apply, so a
  -- removed material must stay resolvable for reviews that captured it.
  deleted_at   timestamptz,

  constraint materials_id_workspace_uq unique (id, workspace_id)
);

-- ---------------------------------------------------------------------------
-- material_links  (reuse references without copying bytes, section 3.2)
-- ---------------------------------------------------------------------------
create table material_links (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null,
  material_id         uuid not null,
  task_id             uuid,
  discussion_entry_id uuid,
  created_at          timestamptz not null default now(),

  -- Cross-workspace attachment is impossible: both FKs carry workspace_id.
  constraint material_links_material_fk
    foreign key (material_id, workspace_id) references materials (id, workspace_id) on delete cascade,
  constraint material_links_task_fk
    foreign key (task_id, workspace_id) references tasks (id, workspace_id) on delete cascade,
  -- And the entry must belong to the same task.
  constraint material_links_entry_fk
    foreign key (discussion_entry_id, task_id) references discussion_entries (id, task_id) on delete cascade,
  constraint material_links_entry_needs_task_ck
    check (discussion_entry_id is null or task_id is not null)
);

-- ---------------------------------------------------------------------------
-- draft_files  (live Yjs document persistence, sections 7.2-7.3)
-- ---------------------------------------------------------------------------
create table draft_files (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null,
  task_id            uuid not null,
  path               text not null check (char_length(path) between 1 and 400),
  -- Bumping an epoch creates a NEW row and closes the old one. Section 7.6
  -- forbids reusing a closed epoch for new approved content, so epoch is part
  -- of the row identity rather than a mutable counter.
  epoch              integer not null default 1 check (epoch >= 1),
  base_blob_sha      text,
  -- Full Yjs binary state plus state vector. Section 11.3: plain text alone
  -- cannot reconstruct the collaborative operation history.
  yjs_state          bytea,
  state_vector       bytea,
  persisted_revision bigint not null default 0 check (persisted_revision >= 0),
  status             draft_status not null default 'active',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint draft_files_task_fk
    foreign key (task_id, workspace_id) references tasks (id, workspace_id) on delete cascade,
  constraint draft_files_epoch_uq unique (task_id, path, epoch),
  constraint draft_files_id_workspace_uq unique (id, workspace_id)
);

-- ---------------------------------------------------------------------------
-- task_input_links  (explicit selected inputs, section 3.3)
-- ---------------------------------------------------------------------------
create table task_input_links (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null,
  task_id        uuid not null,
  material_id    uuid,
  draft_file_id  uuid,
  approved_path  text check (char_length(approved_path) between 1 and 400),
  -- Content hash, commit SHA, or epoch marker depending on the source kind.
  source_version text,
  created_at     timestamptz not null default now(),

  constraint task_input_links_task_fk
    foreign key (task_id, workspace_id) references tasks (id, workspace_id) on delete cascade,
  constraint task_input_links_material_fk
    foreign key (material_id, workspace_id) references materials (id, workspace_id) on delete cascade,
  constraint task_input_links_draft_fk
    foreign key (draft_file_id, workspace_id) references draft_files (id, workspace_id) on delete cascade,
  constraint task_input_links_one_source_ck
    check (num_nonnulls(material_id, draft_file_id, approved_path) = 1)
);

-- ---------------------------------------------------------------------------
-- draft_checkpoints  (persisted collaborative state -> Git, section 7.4)
-- ---------------------------------------------------------------------------
create table draft_checkpoints (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null,
  task_id            uuid not null,
  commit_sha         text not null check (commit_sha ~ '^[0-9a-f]{40}$'),
  -- { draftFileId: revision } captured at the checkpoint boundary.
  document_revisions jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),

  constraint draft_checkpoints_task_fk
    foreign key (task_id, workspace_id) references tasks (id, workspace_id) on delete cascade,
  constraint draft_checkpoints_id_task_uq unique (id, task_id)
);

-- ---------------------------------------------------------------------------
-- runs  (one explicit execution attempt, section 2.2)
-- ---------------------------------------------------------------------------
create table runs (
  id                    uuid primary key default gen_random_uuid(),
  workspace_id          uuid not null,
  task_id               uuid not null,
  attempt               integer not null check (attempt >= 1),
  -- Versions and cutoff are fixed at creation and never edited afterwards.
  task_version          integer not null check (task_version >= 1),
  guidance_version      integer not null check (guidance_version >= 1),
  discussion_cutoff_seq bigint not null check (discussion_cutoff_seq >= 0),
  -- Start idempotency key (section 2.2).
  client_request_id     text check (char_length(client_request_id) between 1 and 200),
  -- Filled by orchestration after the response returns; null while capturing.
  input_snapshot_sha    text check (input_snapshot_sha ~ '^[0-9a-f]{40}$'),
  context_manifest      jsonb,
  result_head_sha       text check (result_head_sha ~ '^[0-9a-f]{40}$'),
  -- Identifies the process that owns this attempt (section 14.4).
  boot_id               uuid not null,
  status                run_status not null default 'planning',
  created_at            timestamptz not null default now(),
  ended_at              timestamptz,

  constraint runs_task_fk
    foreign key (task_id, workspace_id) references tasks (id, workspace_id) on delete cascade,
  constraint runs_attempt_uq unique (task_id, attempt),
  constraint runs_id_task_uq unique (id, task_id)
);

-- ---------------------------------------------------------------------------
-- task_agent_budgets  (section 9.3)
-- ---------------------------------------------------------------------------
-- One cumulative budget per (task, logical agent). Survives retries: a new
-- attempt reuses this row and never zeroes it. Keyed by agent_key, not by
-- instance id.
create table task_agent_budgets (
  workspace_id    uuid not null,
  task_id         uuid not null,
  agent_key       text not null check (char_length(agent_key) between 1 and 120),
  token_budget    bigint not null check (token_budget >= 0),
  consumed_tokens bigint not null default 0 check (consumed_tokens >= 0),
  reserved_tokens bigint not null default 0 check (reserved_tokens >= 0),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- Deliberately NO check that consumed + reserved <= token_budget.
  -- Section 9.2: "late usage may still be recorded" after a deadline abort,
  -- and section 9.3 reconciles against provider-reported usage which can
  -- legitimately overshoot the reservation. A hard check would make honest
  -- reconciliation fail. Enforcement happens before the call, not after.
  primary key (task_id, agent_key),
  constraint task_agent_budgets_task_fk
    foreign key (task_id, workspace_id) references tasks (id, workspace_id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- agent_instances  (per-attempt agent work and deadline)
-- ---------------------------------------------------------------------------
create table agent_instances (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null,
  task_id        uuid not null,
  run_id         uuid not null,
  -- Stable across attempts; keys the budget row.
  agent_key      text not null check (char_length(agent_key) between 1 and 120),
  -- Unique within this run; the plan's assignment id.
  assignment_key text not null check (char_length(assignment_key) between 1 and 120),
  preset         agent_preset not null,
  model_id       text not null,
  status         agent_status not null default 'pending',
  instruction    text not null default '',
  write_paths    text[] not null default '{}',
  base_sha       text check (base_sha ~ '^[0-9a-f]{40}$'),
  result_sha     text check (result_sha ~ '^[0-9a-f]{40}$'),
  boot_id        uuid not null,
  -- Set when the agent begins its first execution activity; deadline_at is
  -- started_at + 600s and is never extended (section 9.2).
  started_at     timestamptz,
  deadline_at    timestamptz,
  ended_at       timestamptz,
  created_at     timestamptz not null default now(),

  constraint agent_instances_task_fk
    foreign key (task_id, workspace_id) references tasks (id, workspace_id) on delete cascade,
  constraint agent_instances_run_fk
    foreign key (run_id, task_id) references runs (id, task_id) on delete cascade,
  constraint agent_instances_budget_fk
    foreign key (task_id, agent_key) references task_agent_budgets (task_id, agent_key),
  constraint agent_instances_assignment_uq unique (run_id, assignment_key),
  constraint agent_instances_id_run_uq unique (id, run_id),
  constraint agent_instances_deadline_ck
    check ((started_at is null) = (deadline_at is null))
);

-- ---------------------------------------------------------------------------
-- agent_dependencies  (validated execution graph, section 8.3)
-- ---------------------------------------------------------------------------
-- Both FKs carry run_id, so a dependency can never cross runs. Acyclicity is
-- validated in application code before dispatch (section 11.2); foreign keys
-- cannot express it.
create table agent_dependencies (
  run_id                uuid not null,
  agent_id              uuid not null,
  prerequisite_agent_id uuid not null,

  primary key (agent_id, prerequisite_agent_id),
  constraint agent_dependencies_agent_fk
    foreign key (agent_id, run_id) references agent_instances (id, run_id) on delete cascade,
  constraint agent_dependencies_prereq_fk
    foreign key (prerequisite_agent_id, run_id) references agent_instances (id, run_id) on delete cascade,
  constraint agent_dependencies_no_self_ck
    check (agent_id <> prerequisite_agent_id)
);

-- ---------------------------------------------------------------------------
-- agent_questions  (section 2.6)
-- ---------------------------------------------------------------------------
-- A question is a record bound to an agent instance, displayed through a
-- discussion entry. The answer is an ordinary discussion entry linked back.
create table agent_questions (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null,
  task_id           uuid not null,
  run_id            uuid not null,
  agent_instance_id uuid not null,
  question_entry_id uuid not null,
  answer_entry_id   uuid,
  status            question_status not null default 'open',
  asked_at          timestamptz not null default now(),
  -- The asking agent's existing deadline. Asking never extends it.
  expires_at        timestamptz not null,
  resolved_at       timestamptz,

  constraint agent_questions_run_fk
    foreign key (run_id, task_id) references runs (id, task_id) on delete cascade,
  constraint agent_questions_agent_fk
    foreign key (agent_instance_id, run_id) references agent_instances (id, run_id) on delete cascade,
  constraint agent_questions_entry_fk
    foreign key (question_entry_id, task_id) references discussion_entries (id, task_id) on delete cascade,
  constraint agent_questions_answer_fk
    foreign key (answer_entry_id, task_id) references discussion_entries (id, task_id) on delete restrict,
  constraint agent_questions_entry_uq unique (question_entry_id),
  constraint agent_questions_answered_ck
    check ((status = 'answered') = (answer_entry_id is not null)),
  constraint agent_questions_resolved_ck
    check ((status = 'open') = (resolved_at is null))
);

-- ---------------------------------------------------------------------------
-- model_calls  (usage and retry accounting, section 9.3)
-- ---------------------------------------------------------------------------
create table model_calls (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null,
  task_id             uuid not null,
  agent_id            uuid not null references agent_instances (id) on delete cascade,
  request_key         text not null check (char_length(request_key) between 1 and 200),
  provider_request_id text,
  model_id            text not null,
  reserved_tokens     bigint not null default 0 check (reserved_tokens >= 0),
  reported_usage      jsonb,
  -- 'unknown' keeps the reservation held: section 9.3 says a failed request
  -- with missing usage does not give the budget back.
  status              model_call_status not null default 'reserved',
  created_at          timestamptz not null default now(),
  settled_at          timestamptz,

  constraint model_calls_request_uq unique (agent_id, request_key)
);

-- ---------------------------------------------------------------------------
-- task_events  (durable progress and refresh source, section 11.5)
-- ---------------------------------------------------------------------------
create table task_events (
  id           bigint generated always as identity primary key,
  workspace_id uuid not null,
  task_id      uuid not null,
  run_id       uuid,
  -- Deterministic where an operation may repeat, so a retried append is a
  -- no-op instead of a duplicate entry.
  event_key    text not null check (char_length(event_key) between 1 and 200),
  type         text not null check (char_length(type) between 1 and 80),
  payload      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),

  constraint task_events_task_fk
    foreign key (task_id, workspace_id) references tasks (id, workspace_id) on delete cascade,
  constraint task_events_run_fk
    foreign key (run_id, task_id) references runs (id, task_id) on delete cascade,
  constraint task_events_key_uq unique (task_id, event_key)
);

-- ---------------------------------------------------------------------------
-- reviews  (exact candidate and source tuple, section 10.1)
-- ---------------------------------------------------------------------------
create table reviews (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null,
  task_id            uuid not null,
  run_id             uuid,
  -- The source tuple. Apply re-validates every element (section 10.3).
  task_version       integer not null check (task_version >= 1),
  guidance_version   integer not null check (guidance_version >= 1),
  main_sha           text not null check (main_sha ~ '^[0-9a-f]{40}$'),
  human_sha          text not null check (human_sha ~ '^[0-9a-f]{40}$'),
  -- Null for a manual-edit task: section 10.1 says G is absent.
  result_sha         text check (result_sha ~ '^[0-9a-f]{40}$'),
  document_revisions jsonb not null default '{}'::jsonb,
  context_hash       text not null,
  candidate_sha      text check (candidate_sha ~ '^[0-9a-f]{40}$'),
  status             review_status not null default 'building',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint reviews_task_fk
    foreign key (task_id, workspace_id) references tasks (id, workspace_id) on delete cascade,
  constraint reviews_run_fk
    foreign key (run_id, task_id) references runs (id, task_id) on delete cascade,
  -- Only a review still building may lack a candidate.
  constraint reviews_candidate_ck
    check (status = 'building' or candidate_sha is not null)
);

-- ---------------------------------------------------------------------------
-- apply_operations  (duplicate protection, section 10.5)
-- ---------------------------------------------------------------------------
-- Git and PostgreSQL do not share a transaction. One pending row per review is
-- written before the ref update so a lost response can be reconciled against
-- main instead of applied twice.
create table apply_operations (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null,
  review_id         uuid not null unique references reviews (id) on delete cascade,
  expected_main_sha text not null check (expected_main_sha ~ '^[0-9a-f]{40}$'),
  candidate_sha     text not null check (candidate_sha ~ '^[0-9a-f]{40}$'),
  status            apply_status not null default 'pending',
  boot_id           uuid not null,
  error_code        text,
  created_at        timestamptz not null default now(),
  settled_at        timestamptz
);
