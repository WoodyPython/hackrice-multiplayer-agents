import type { Db } from '../db/client.js';
import {
  clip,
  type ActivitySnapshot,
  type SnapshotActivity,
  type SnapshotAttention,
  type SnapshotExcerpt,
  type SnapshotFile,
} from './compose.js';

/**
 * Reads one workspace's records for a briefing window.
 *
 * Read-only, and scoped by workspace in every query. The activity copy is built
 * here from the rows themselves, so the recap shown when Gemini is unavailable
 * says exactly what the records say and nothing more.
 */

export interface BriefingSources {
  /** Paths on approved main right now. Absent or failing: no file is approved. */
  approvedPaths?(workspaceId: string): Promise<ReadonlySet<string>>;
  /** Paths an applied review changed. Absent or failing: none are named. */
  reviewChangedPaths?(workspaceId: string, reviewId: string): Promise<string[]>;
}

const EVENT_TYPES = [
  'task.posted', 'task.status_changed', 'task.started', 'task.canceled', 'task.requirements_changed',
  'agent.completed', 'agent.failed', 'agent.timed_out', 'agent.token_exhausted', 'agent.waiting',
  'agent.question_answered', 'draft.checkpointed', 'review.ready', 'review.stale', 'review.assessed',
] as const;

const UNFINISHED = new Set(['agent.failed', 'agent.timed_out', 'agent.token_exhausted']);

const STATUS_LABELS: Record<string, string> = {
  posted: 'Posted', planning: 'Planning', working: 'Working', needs_input: 'Needs input',
  ready_for_review: 'In review', awaiting_confirmation: 'Awaiting confirmation', conflict: 'Conflict',
  incomplete: 'Incomplete', interrupted: 'Interrupted', canceled: 'Canceled', completed: 'Completed',
};
const statusLabel = (status: unknown) =>
  typeof status === 'string' ? STATUS_LABELS[status] ?? status.replace(/_/g, ' ') : 'another state';

const ACTIVITY_LIMIT = 60;
const MAX_APPLIED_FILE_LOOKUPS = 10;
const MAX_FILES_PER_ITEM = 12;

export async function collectActivity(
  db: Db, workspaceId: string, since: Date, until: Date, sources: BriefingSources = {},
): Promise<ActivitySnapshot> {
  const [tasks, events, comments, questions, reviews, applies, drafts] = await Promise.all([
    db.selectFrom('tasks').select(['id', 'title', 'status', 'updated_at'])
      .where('workspace_id', '=', workspaceId).orderBy('updated_at', 'desc').limit(1000).execute(),
    db.selectFrom('task_events').select(['id', 'task_id', 'run_id', 'type', 'payload', 'created_at'])
      .where('workspace_id', '=', workspaceId).where('type', 'in', [...EVENT_TYPES])
      .where('created_at', '>', since).where('created_at', '<=', until)
      .orderBy('id', 'desc').limit(500).execute(),
    db.selectFrom('discussion_entries as d')
      .leftJoin('agent_questions as q', 'q.question_entry_id', 'd.id')
      .select(['d.task_id', 'd.actor_type', 'd.guest_label', 'd.body', 'd.created_at'])
      .where('d.workspace_id', '=', workspaceId).where('q.id', 'is', null)
      .where('d.created_at', '>', since).where('d.created_at', '<=', until)
      .orderBy('d.created_at', 'desc').limit(500).execute(),
    db.selectFrom('agent_questions as q').innerJoin('discussion_entries as d', 'd.id', 'q.question_entry_id')
      .select(['q.id', 'q.task_id', 'q.asked_at', 'd.body'])
      .where('q.workspace_id', '=', workspaceId).where('q.status', '=', 'open').where('q.expires_at', '>', until)
      .orderBy('q.asked_at', 'desc').limit(20).execute(),
    db.selectFrom('reviews').select(['id', 'task_id', 'status', 'created_at', 'updated_at'])
      .where('workspace_id', '=', workspaceId).orderBy('created_at', 'desc').limit(500).execute(),
    db.selectFrom('apply_operations as a').innerJoin('reviews as r', 'r.id', 'a.review_id')
      .select(['a.id', 'a.review_id', 'a.status', 'a.created_at', 'a.settled_at', 'r.task_id'])
      .where('a.workspace_id', '=', workspaceId)
      .where((eb) => eb.or([
        eb.and([eb('a.created_at', '>', since), eb('a.created_at', '<=', until)]),
        eb.and([eb('a.settled_at', '>', since), eb('a.settled_at', '<=', until)]),
      ]))
      .orderBy('a.created_at', 'desc').limit(50).execute(),
    db.selectFrom('draft_files').select(['task_id', 'path', 'updated_at'])
      .where('workspace_id', '=', workspaceId).where('updated_at', '>', since).where('updated_at', '<=', until)
      .orderBy('updated_at', 'desc').limit(200).execute(),
  ]);

  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const title = (taskId: string) => `“${taskById.get(taskId)?.title ?? 'a task'}”`;
  const reviewById = new Map(reviews.map((review) => [review.id, review]));
  const approved = await safely(() => sources.approvedPaths?.(workspaceId), new Set<string>()) ?? new Set<string>();
  const activity: SnapshotActivity[] = [];
  let records = 0;

  // One line per task for repetitive records; the latest time stands for the group.
  const groups = new Map<string, { at: Date; count: number; taskId: string; build: (count: number) => string }>();
  const group = (id: string, at: Date, taskId: string, build: (count: number) => string) => {
    const existing = groups.get(id);
    if (existing) { existing.count += 1; if (at > existing.at) existing.at = at; }
    else groups.set(id, { at, count: 1, taskId, build });
  };

  for (const event of events) {
    const taskId = event.task_id;
    const at = event.created_at;
    const payload = event.payload ?? {};
    const reviewId = typeof payload.reviewId === 'string' && reviewById.get(payload.reviewId)?.task_id === taskId
      ? payload.reviewId : null;
    records += 1;
    switch (event.type) {
      case 'task.posted':
        activity.push({ at, taskId, reviewId: null, files: [], text: `${title(taskId)} was posted` });
        break;
      case 'task.status_changed':
        activity.push({ at, taskId, reviewId: null, files: [],
          text: `${title(taskId)} moved from ${statusLabel(payload.from)} to ${statusLabel(payload.to)}` });
        break;
      case 'task.started': {
        const attempt = typeof payload.attempt === 'number' ? ` (attempt ${payload.attempt})` : '';
        activity.push({ at, taskId, reviewId: null, files: [], text: `Agents started work on ${title(taskId)}${attempt}` });
        break;
      }
      case 'task.canceled':
        activity.push({ at, taskId, reviewId: null, files: [], text: `The running attempt on ${title(taskId)} was stopped` });
        break;
      case 'task.requirements_changed':
        group(`req:${taskId}`, at, taskId, (count) => count > 1
          ? `Requirements for ${title(taskId)} were revised ${count} times`
          : `Requirements for ${title(taskId)} were revised`);
        break;
      case 'agent.completed':
        group(`done:${taskId}`, at, taskId, (count) => `Agents completed ${count} step${count === 1 ? '' : 's'} on ${title(taskId)}`);
        break;
      case 'agent.waiting':
        if (typeof payload.questionId !== 'string') { records -= 1; break; }
        activity.push({ at, taskId, reviewId: null, files: [], text: `An agent asked a question on ${title(taskId)}` });
        break;
      case 'agent.question_answered':
        activity.push({ at, taskId, reviewId: null, files: [], text: `An agent question on ${title(taskId)} was answered` });
        break;
      case 'draft.checkpointed':
        group(`checkpoint:${taskId}`, at, taskId, (count) => count > 1
          ? `Drafts on ${title(taskId)} were checkpointed ${count} times`
          : `Drafts on ${title(taskId)} were checkpointed`);
        break;
      case 'review.ready':
        activity.push({ at, taskId, reviewId, files: [], text: `Changes for ${title(taskId)} became ready to review` });
        break;
      case 'review.stale':
        activity.push({ at, taskId, reviewId, files: [], text: `The review of ${title(taskId)} went out of date after newer edits` });
        break;
      case 'review.assessed':
        activity.push({ at, taskId, reviewId, files: [], text: `A reviewer assessment was recorded for ${title(taskId)}` });
        break;
      default:
        if (UNFINISHED.has(event.type)) {
          group(`unfinished:${taskId}`, at, taskId, (count) =>
            `${count} agent step${count === 1 ? '' : 's'} on ${title(taskId)} did not finish`);
        } else {
          records -= 1;
        }
    }
  }

  // Discussion, one line per task.
  const byTask = new Map<string, typeof comments>();
  for (const entry of comments) byTask.set(entry.task_id, [...(byTask.get(entry.task_id) ?? []), entry]);
  const excerpts: SnapshotExcerpt[] = [];
  for (const [taskId, entries] of byTask) {
    records += entries.length;
    const people = [...new Set(entries.filter((entry) => entry.guest_label).map((entry) => entry.guest_label!))];
    const agents = entries.some((entry) => entry.actor_type === 'agent');
    const names = [...people.slice(0, 3), ...(people.length > 3 ? [`${people.length - 3} more`] : []), ...(agents ? ['agents'] : [])];
    const count = entries.length;
    activity.push({
      at: entries[0]!.created_at, taskId, reviewId: null, files: [],
      text: `${count} new comment${count === 1 ? '' : 's'} on ${title(taskId)}${names.length ? ` from ${joinNames(names)}` : ''}`,
    });
    for (const entry of entries.filter((e) => e.actor_type !== 'system').slice(0, 2)) {
      excerpts.push({ taskId, author: entry.guest_label ?? 'Agent', text: clip(entry.body, 400), at: entry.created_at });
    }
  }

  // Applied, failed, and pending publications, with the files they changed.
  let applied = 0;
  let lookups = 0;
  for (const operation of applies) {
    records += 1;
    const taskId = operation.task_id;
    const at = operation.settled_at && operation.settled_at <= until ? operation.settled_at : operation.created_at;
    let files: SnapshotFile[] = [];
    if (operation.status === 'applied') {
      applied += 1;
      if (lookups++ < MAX_APPLIED_FILE_LOOKUPS) {
        const paths = await safely(() => sources.reviewChangedPaths?.(workspaceId, operation.review_id), []) ?? [];
        files = paths.filter((path) => approved.has(path)).slice(0, MAX_FILES_PER_ITEM)
          .map((path) => ({ path, approved: true, taskId: null }));
      }
    }
    const text = operation.status === 'applied' ? `Changes from ${title(taskId)} were applied to the approved files`
      : operation.status === 'failed' ? `Applying changes from ${title(taskId)} did not succeed; the approved files are unchanged`
        : operation.status === 'ambiguous' ? `Applying changes from ${title(taskId)} has an unknown outcome and needs checking`
          : `Changes from ${title(taskId)} are being applied`;
    activity.push({ at, taskId, reviewId: reviewById.has(operation.review_id) ? operation.review_id : null, files, text });
  }

  // Draft edits, one line per task.
  const draftsByTask = new Map<string, typeof drafts>();
  for (const draft of drafts) draftsByTask.set(draft.task_id, [...(draftsByTask.get(draft.task_id) ?? []), draft]);
  for (const [taskId, rows] of draftsByTask) {
    records += 1;
    const paths = [...new Set(rows.map((row) => row.path))];
    activity.push({
      at: rows[0]!.updated_at, taskId, reviewId: null,
      files: paths.slice(0, MAX_FILES_PER_ITEM).map((path) => ({ path, approved: false, taskId })),
      text: `Drafts were edited on ${title(taskId)}: ${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ` and ${paths.length - 3} more` : ''}`,
    });
  }

  for (const entry of groups.values()) {
    activity.push({ at: entry.at, taskId: entry.taskId, reviewId: null, files: [], text: entry.build(entry.count) });
  }

  const known = activity.filter((item) => item.taskId === null || taskById.has(item.taskId))
    .sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, ACTIVITY_LIMIT);

  return {
    since, until,
    tasks: tasks.map((task) => ({ id: task.id, title: task.title, status: task.status })),
    reviews: reviews.map((review) => ({ id: review.id, taskId: review.task_id, status: review.status })),
    questions: questions.filter((question) => taskById.has(question.task_id))
      .map((question) => ({ id: question.id, taskId: question.task_id, text: question.body, askedAt: question.asked_at })),
    activity: known,
    attention: attention(tasks, reviews, questions, title),
    excerpts,
    counts: { records, comments: comments.length, applied },
  };
}

/**
 * What is waiting on a person right now, independent of the window: open agent
 * questions, and tasks whose review is in a state someone has to act on.
 */
function attention(
  tasks: Array<{ id: string; status: string; updated_at: Date }>,
  reviews: Array<{ id: string; task_id: string; status: string; updated_at: Date }>,
  questions: Array<{ id: string; task_id: string; asked_at: Date; body: string }>,
  title: (taskId: string) => string,
): SnapshotAttention[] {
  const items: SnapshotAttention[] = [];
  const taskIds = new Set(tasks.map((task) => task.id));
  for (const question of questions) {
    if (!taskIds.has(question.task_id)) continue;
    items.push({ kind: 'question', at: question.asked_at, taskId: question.task_id, reviewId: null,
      text: `An agent is waiting for an answer on ${title(question.task_id)}: ${clip(question.body, 160)}` });
  }
  const latestReview = new Map<string, (typeof reviews)[number]>();
  for (const review of reviews) if (!latestReview.has(review.task_id)) latestReview.set(review.task_id, review);
  for (const task of tasks) {
    if (!['ready_for_review', 'conflict', 'awaiting_confirmation'].includes(task.status)) continue;
    const review = latestReview.get(task.id);
    const live = review && (task.status === 'awaiting_confirmation' ? review.status === 'applied'
      : ['building', 'ready', 'conflict', 'stale'].includes(review.status)) ? review : undefined;
    const text = task.status === 'awaiting_confirmation'
      ? `Changes from ${title(task.id)} were applied and are waiting to be marked complete`
      : task.status === 'conflict' || live?.status === 'conflict' ? `${title(task.id)} has overlapping edits to resolve`
        : live?.status === 'stale' ? `The review of ${title(task.id)} is out of date and needs refreshing`
          : live?.status === 'ready' ? `Changes for ${title(task.id)} are ready to review`
            : live?.status === 'building' ? `A review of ${title(task.id)} is being prepared`
              : `${title(task.id)} is ready for review`;
    items.push({ kind: 'review', at: live?.updated_at ?? task.updated_at, taskId: task.id, reviewId: live?.id ?? null, text });
  }
  return items.sort((a, b) => b.at.getTime() - a.at.getTime());
}

function joinNames(names: string[]): string {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

async function safely<T>(read: () => Promise<T> | undefined, fallback: T): Promise<T | undefined> {
  try { return (await read()) ?? fallback; } catch { return fallback; }
}
