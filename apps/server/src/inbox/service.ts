import { ApiError, listInboxResponseSchema, type InboxItem } from '@app/contracts';
import { sql } from 'kysely';
import type { Db } from '../db/client.js';

/** A snapshot of live issues, never a second notification lifecycle to maintain.
 * Link holders have the same read access as the board. All source joins remain
 * workspace scoped; acting on an item goes through the existing task and review
 * APIs and their permission checks, never through this read.
 */
export async function listInbox(db: Db, workspaceId: string): Promise<InboxItem[]> {
  return db.transaction().setIsolationLevel('repeatable read').execute(async (trx) => {
    const workspace = await trx.selectFrom('workspaces').select('id')
      .where('id', '=', workspaceId).executeTakeFirst();
    if (!workspace) throw new ApiError('WORKSPACE_NOT_FOUND');
    const result = await sql<Omit<InboxItem, 'timestamp'> & { timestamp: Date }>`
      with current_tasks as (
        select t.*, r.id as run_id, r.status as run_status, r.ended_at,
          v.id as review_id, v.status as review_status, v.updated_at as review_updated_at,
          b.created_at as blocked_at
        from tasks t
        left join lateral (
          select r.* from runs r where r.workspace_id = t.workspace_id and r.task_id = t.id
          order by r.attempt desc limit 1
        ) r on true
        left join lateral (
          select v.* from reviews v where v.workspace_id = t.workspace_id and v.task_id = t.id
            and v.status in ('building', 'ready', 'stale', 'conflict')
          order by v.created_at desc, v.id desc limit 1
        ) v on true
        left join lateral (
          select e.created_at from task_events e
          where e.workspace_id = t.workspace_id and e.task_id = t.id and e.run_id = r.id
            and e.type = 'agent.waiting' and e.payload->>'phase' = 'scheduler'
            and e.payload->>'reason' = 'blocked'
          order by e.id desc limit 1
        ) b on true
        where t.workspace_id = ${workspaceId}::uuid and t.status not in ('completed', 'canceled')
      ), issues as (
        select 'question:' || q.id as id, 'question' as type, t.id as "taskId", t.title as "taskTitle",
          q.asked_at as timestamp, d.body as summary, q.id as "questionId",
          null::uuid as "reviewId", q.run_id as "runId"
        from current_tasks t
        join agent_questions q on q.workspace_id = t.workspace_id and q.task_id = t.id and q.run_id = t.active_run_id
        join discussion_entries d on d.workspace_id = t.workspace_id and d.task_id = t.id and d.id = q.question_entry_id
        join agent_instances a on a.workspace_id = t.workspace_id and a.task_id = t.id and a.run_id = q.run_id and a.id = q.agent_instance_id
        where q.status = 'open' and q.expires_at > now()
          and t.run_status in ('planning', 'working', 'needs_input')
          and a.status in ('running', 'needs_input') and a.deadline_at > now()
        union all
        select 'review:' || t.id, 'review', t.id, t.title,
          coalesce(t.review_updated_at, t.updated_at),
          case when t.review_status = 'stale' then 'Refresh the review to inspect the latest changes.'
            when t.review_status = 'building' then 'Changes are being prepared for review.'
            else 'Changes are ready to review.' end,
          null::uuid, t.review_id, t.run_id
        from current_tasks t
        -- A rebuild passes through 'building'; keeping it here stops the item
        -- (and the badge) from flickering out while the review is refreshed.
        where t.active_run_id is null and (t.status = 'ready_for_review'
          or (t.status = 'posted' and t.kind = 'manual_edit' and t.review_status in ('building', 'ready', 'stale')))
          and (t.review_status is null or t.review_status <> 'conflict')
        union all
        select 'blocker:' || t.id, 'blocker', t.id, t.title,
          coalesce(t.review_updated_at, t.blocked_at, t.updated_at),
          case when t.status = 'conflict' or t.review_status = 'conflict'
            then 'Conflicting changes need a decision.' else 'An assignment is blocked by an unsuccessful prerequisite.' end,
          null::uuid, t.review_id, t.run_id
        from current_tasks t
        where t.status = 'conflict'
          or (t.active_run_id is null and t.status in ('posted', 'ready_for_review') and t.review_status = 'conflict')
          or (t.blocked_at is not null and t.status in ('working', 'needs_input', 'incomplete', 'interrupted'))
        union all
        select 'failed_run:' || t.run_id, 'failed_run', t.id, t.title,
          coalesce(t.ended_at, t.updated_at),
          case when t.run_status = 'interrupted' then 'The latest run was interrupted.' else 'The latest run did not finish successfully.' end,
          null::uuid, null::uuid, t.run_id
        from current_tasks t
        where t.active_run_id is null and t.status in ('incomplete', 'interrupted')
          and t.run_status in ('incomplete', 'interrupted') and t.blocked_at is null
      ) select * from issues order by timestamp desc, id
    `.execute(trx);
    return listInboxResponseSchema.parse({ items: result.rows.map((row) => ({
      ...row, timestamp: row.timestamp.toISOString(),
    })) }).items;
  });
}
