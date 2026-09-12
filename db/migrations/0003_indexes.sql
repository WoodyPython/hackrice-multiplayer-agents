-- B01: the uniqueness rules from design section 11.2, plus read-path indexes.
--
-- Each partial unique index below is a business rule the database enforces.
-- Application code maps the resulting 23505 to the matching error code from
-- section 12.5 rather than re-checking in a racy SELECT-then-INSERT.

-- ---------------------------------------------------------------------------
-- tasks.active_run_id must point at a run of this same task.
-- ---------------------------------------------------------------------------
-- Deferred so cascade deletion of a task (which removes its runs and the
-- referencing task row in one statement) does not trip the constraint.
alter table tasks
  add constraint tasks_active_run_fk
  foreign key (active_run_id, id) references runs (id, task_id)
  deferrable initially deferred;

-- ---------------------------------------------------------------------------
-- Unique active run per task (section 11.2).
-- ---------------------------------------------------------------------------
-- Second half of the duplicate-Start guard: this rejects a genuinely
-- concurrent request. The idempotency index below handles a replayed one.
create unique index runs_active_uq
  on runs (task_id)
  where status in ('planning', 'working', 'needs_input');

-- Start idempotency: a replayed request resolves to its original run.
create unique index runs_client_request_uq
  on runs (task_id, client_request_id)
  where client_request_id is not null;

-- ---------------------------------------------------------------------------
-- Discussion idempotency: a double-tapped comment cannot double-post.
-- ---------------------------------------------------------------------------
create unique index discussion_entries_client_request_uq
  on discussion_entries (task_id, client_request_id)
  where client_request_id is not null;

-- ---------------------------------------------------------------------------
-- One active manual-edit task per workspace/file (sections 2.5, 11.2).
-- ---------------------------------------------------------------------------
-- Terminal here is ('completed', 'canceled') only. A task sitting in
-- 'incomplete' or 'interrupted' still owns the file: section 2.4 offers manual
-- retry from both, so opening a second editor on that path would fork the
-- draft behind the user's back.
create unique index tasks_manual_active_uq
  on tasks (workspace_id, manual_source_path)
  where kind = 'manual_edit' and status not in ('completed', 'canceled');

-- ---------------------------------------------------------------------------
-- One active draft document per task/path (section 11.2).
-- ---------------------------------------------------------------------------
-- Closed epochs stay in the table as history; only one row per path is live.
create unique index draft_files_active_uq
  on draft_files (task_id, path)
  where status = 'active';

-- ---------------------------------------------------------------------------
-- One open question per agent instance (section 2.6).
-- ---------------------------------------------------------------------------
-- An agent has one in-flight model request (section 8.7), so it cannot be
-- waiting on two answers at once.
create unique index agent_questions_one_open_uq
  on agent_questions (agent_instance_id)
  where status = 'open';

-- ---------------------------------------------------------------------------
-- Material reuse (section 3.2): identical bytes in a workspace are one
-- material, so reattaching reuses the existing ID and object.
-- ---------------------------------------------------------------------------
create unique index materials_content_uq
  on materials (workspace_id, sha256)
  where deleted_at is null;

-- Attaching the same material to the same place twice is a no-op.
-- NULLS NOT DISTINCT (PG15+) so a workspace-level link (task_id null) also
-- dedupes instead of inserting unbounded duplicates.
create unique index material_links_dedupe_uq
  on material_links (material_id, task_id, discussion_entry_id)
  nulls not distinct;

-- ---------------------------------------------------------------------------
-- Read paths.
-- ---------------------------------------------------------------------------
create index tasks_board_idx on tasks (workspace_id, status, updated_at desc);
create index tasks_workspace_idx on tasks (workspace_id, created_at desc);
create index discussion_entries_read_idx on discussion_entries (task_id, seq);
create index materials_workspace_idx on materials (workspace_id, created_at desc) where deleted_at is null;
create index material_links_task_idx on material_links (task_id);
create index material_links_material_idx on material_links (material_id);
create index task_input_links_task_idx on task_input_links (task_id);
create index draft_files_task_idx on draft_files (task_id) where status = 'active';
create index draft_checkpoints_task_idx on draft_checkpoints (task_id, created_at desc);
create index runs_task_idx on runs (task_id, attempt desc);
create index agent_instances_run_idx on agent_instances (run_id, status);
create index agent_questions_open_idx on agent_questions (run_id) where status = 'open';
create index model_calls_agent_idx on model_calls (agent_id, created_at);
create index task_events_read_idx on task_events (task_id, id);
create index reviews_task_idx on reviews (task_id, created_at desc);
create index apply_operations_pending_idx on apply_operations (boot_id) where status = 'pending';
