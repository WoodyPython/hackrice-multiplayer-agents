import { Clock3, FileText, Settings } from 'lucide-react';
import { AppShell } from '../components/AppShell.js';

function Placeholder({ icon: Icon, eyebrow, title, description }: { icon: typeof FileText; eyebrow: string; title: string; description: string }) {
  return <AppShell><section className="page-heading"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div></section><div className="full-empty panel"><Icon size={30} /><h2>This view arrives in a later Role A ticket.</h2><p>The route and workspace shell are ready for integration.</p></div></AppShell>;
}

export function FilesPage() { return <Placeholder icon={FileText} eyebrow="Workspace library" title="Files" description="Approved files, references, and active shared drafts." />; }
export function HistoryPage() { return <Placeholder icon={Clock3} eyebrow="Approved work" title="History" description="A record of changes applied to this workspace." />; }
export function SettingsPage() { return <Placeholder icon={Settings} eyebrow="Owner controls" title="Workspace settings" description="Manage workspace details and guidance." />; }
