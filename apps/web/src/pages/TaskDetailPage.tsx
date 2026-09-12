import { ArrowLeft, CheckCircle2, FileText, MessageSquare, Pencil, Play, Users } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { AppShell } from '../components/AppShell.js';
import { fixtureTaskDetails } from '../fixtures/tasks.js';

export function TaskDetailPage() {
  const { workspaceId = '', taskId = '' } = useParams();
  const task = fixtureTaskDetails[taskId];

  if (!task) {
    return (
      <AppShell>
        <div className="full-empty"><FileText size={30} /><h1>Task not found</h1><p>This fixture does not include that task yet.</p><Link className="button button-primary" to={`/w/${workspaceId}`}>Return to tasks</Link></div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <Link className="back-link" to={`/w/${workspaceId}`}><ArrowLeft size={16} /> Tasks</Link>
      <section className="detail-heading">
        <div><span className={`status-pill ${task.status === 'working' ? 'active' : 'neutral'}`}>{task.status.replaceAll('_', ' ')}</span><h1>{task.title}</h1><p>Created by {task.creatorGuestLabel} · Version {task.version}</p></div>
        <div className="detail-actions"><button className="button button-secondary"><Pencil size={16} /> Edit brief</button>{task.status === 'posted' && <button className="button button-primary"><Play size={16} fill="currentColor" /> Start task</button>}</div>
      </section>
      <div className="detail-layout">
        <section className="detail-main panel">
          <div className="detail-section"><span className="eyebrow">Desired outcome</span><p className="outcome-copy">{task.outcome}</p></div>
          <div className="detail-section"><span className="eyebrow">Acceptance criteria</span><ul className="criteria-display">{task.criteria.map((criterion) => <li key={criterion}><CheckCircle2 size={18} />{criterion}</li>)}</ul></div>
          <nav className="task-tabs"><button className="active"><MessageSquare size={16} /> Discussion</button><button><FileText size={16} /> Drafts</button><button><Users size={16} /> Agents</button><button>Changes</button></nav>
          <div className="discussion-empty"><MessageSquare size={23} /><h3>Start the conversation</h3><p>Discuss the brief and attach context before anyone starts agents.</p><textarea placeholder="Add a comment…" rows={3} /><button className="button button-primary compact">Post comment</button></div>
        </section>
        <aside className="detail-aside"><section className="panel context-panel"><span className="eyebrow">Task context</span><div><FileText size={17} /><span><strong>{task.inputs.length} selected materials</strong><small>Captured when the task starts</small></span></div><div><Users size={17} /><span><strong>Shared with contributors</strong><small>Anyone with the link can participate</small></span></div></section><section className="quiet-note"><strong>Posting is separate from starting.</strong><p>Agents only receive this task after someone chooses Start task.</p></section></aside>
      </div>
    </AppShell>
  );
}
