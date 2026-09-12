import { ArrowRight, GitBranch, Sparkles, Users } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { DEMO_WORKSPACE_ID } from '../fixtures/tasks.js';

export function CreateWorkspacePage() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    navigate(`/w/${DEMO_WORKSPACE_ID}`);
  }

  return (
    <main className="create-page">
      <nav className="landing-nav"><span className="brand-mark"><Sparkles size={17} /></span><strong>Relay</strong><span className="demo-badge">MVP workspace</span></nav>
      <div className="create-grid">
        <section className="create-copy">
          <span className="eyebrow">Collaborate at the speed of thought</span>
          <h1>A shared place for people and agents to do their best work.</h1>
          <p>Create a workspace, invite collaborators with one link, and turn agreed requirements into reviewed results.</p>
          <div className="feature-row">
            <span><Users size={18} /><strong>Edit together</strong><small>Live shared drafts</small></span>
            <span><GitBranch size={18} /><strong>Review every change</strong><small>Git-backed history</small></span>
          </div>
        </section>
        <section className="create-card">
          <span className="create-icon"><Sparkles size={22} /></span>
          <h2>Create your workspace</h2>
          <p>No account needed. You’ll receive a contribution link to share.</p>
          <form onSubmit={submit}>
            <div className="field"><label htmlFor="workspace-name">Workspace name</label><input id="workspace-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="HackRice launch" required /></div>
            <div className="field"><label htmlFor="workspace-purpose">Purpose <span>Optional</span></label><textarea id="workspace-purpose" value={purpose} onChange={(event) => setPurpose(event.target.value)} placeholder="What is your team working toward?" rows={3} /></div>
            <button className="button button-primary create-submit" type="submit">Create workspace <ArrowRight size={17} /></button>
          </form>
          <small className="privacy-note">Your browser will keep the owner key for approval actions.</small>
        </section>
      </div>
    </main>
  );
}
