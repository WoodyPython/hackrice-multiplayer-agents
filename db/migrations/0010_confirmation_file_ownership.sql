-- Applied drafts are closed, so a final check must not block new edits.
drop index tasks_manual_active_uq;
create unique index tasks_manual_active_uq
  on tasks (workspace_id, manual_source_path)
  where kind = 'manual_edit' and status not in ('completed', 'canceled', 'awaiting_confirmation');
