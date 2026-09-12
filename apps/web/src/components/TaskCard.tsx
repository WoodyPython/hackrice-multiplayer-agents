import { AlertCircle, Check, FileText, MessageCircle, MoreHorizontal } from 'lucide-react';
import type { TaskStatus, TaskSummary } from '@app/contracts';
import { Link } from 'react-router-dom';

const STATUS_COPY: Record<TaskStatus, { label: string; tone: string }> = {
  posted: { label: 'Ready to start', tone: 'neutral' },
  planning: { label: 'Planning work', tone: 'active' },
  working: { label: '2 agents working', tone: 'active' },
  needs_input: { label: 'Answer needed', tone: 'warning' },
  ready_for_review: { label: 'Ready for review', tone: 'review' },
  conflict: { label: 'Conflict', tone: 'warning' },
  incomplete: { label: 'Incomplete', tone: 'warning' },
  interrupted: { label: 'Interrupted', tone: 'warning' },
  canceled: { label: 'Canceled', tone: 'muted' },
  completed: { label: 'Applied', tone: 'success' },
};

function timeAgo(timestamp: string) {
  const minutes = Math.max(1, Math.round((Date.now() - new Date(timestamp).getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function TaskCard({ task }: { task: TaskSummary }) {
  const status = STATUS_COPY[task.status];
  return (
    <article className="task-card">
      <div className="task-card-top">
        <span className={`status-pill ${status.tone}`}>
          {status.tone === 'success' && <Check size={12} />}
          {status.tone === 'warning' && <AlertCircle size={12} />}
          {status.label}
        </span>
        <button className="card-menu" aria-label={`More actions for ${task.title}`}><MoreHorizontal size={18} /></button>
      </div>
      <Link className="task-card-link" to={`/w/${task.workspaceId}/tasks/${task.id}`}>
        <h3>{task.title}</h3>
        <p>{task.outcome}</p>
      </Link>
      <div className="task-meta">
        {task.materialCount > 0 && <span><FileText size={14} /> {task.materialCount}</span>}
        {task.openQuestionCount > 0 && <span className="attention-meta"><MessageCircle size={14} /> {task.openQuestionCount} question</span>}
        <span className="task-time">{timeAgo(task.updatedAt)}</span>
      </div>
      <div className="task-author">
        <span>{task.creatorGuestLabel.slice(-1)}</span>
        <small>{task.creatorGuestLabel}</small>
      </div>
    </article>
  );
}
