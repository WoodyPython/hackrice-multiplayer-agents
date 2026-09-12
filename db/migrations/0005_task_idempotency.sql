-- B03: idempotency for posting a task.
--
-- Section 11.2 requires "unique client request ID within the relevant task
-- operation scope". B01 gave runs and discussion_entries that column but not
-- tasks, so a double-clicked Post button created two tasks. Posting is squarely
-- such an operation.
--
-- Scoped to the workspace rather than the task, because no task exists yet when
-- the key is presented.

alter table tasks
  add column client_request_id text
    check (char_length(client_request_id) between 1 and 200);

create unique index tasks_client_request_uq
  on tasks (workspace_id, client_request_id)
  where client_request_id is not null;
