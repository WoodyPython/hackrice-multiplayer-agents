import {
  CheckCircle2,
  ChevronDown,
  Clock3,
  Files,
  LayoutDashboard,
  Menu,
  Plus,
  Settings,
  Sparkles,
  X,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router-dom';

interface AppShellProps {
  children: ReactNode;
  onNewTask?: () => void;
}

const navItems = [
  { label: 'Tasks', path: '', icon: LayoutDashboard, end: true },
  { label: 'Files', path: '/files', icon: Files },
  { label: 'History', path: '/history', icon: Clock3 },
];

export function AppShell({ children, onNewTask }: AppShellProps) {
  const { workspaceId = '' } = useParams();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
  const basePath = `/w/${workspaceId}`;

  const sidebar = (
    <>
      <div className="brand">
        <span className="brand-mark"><Sparkles size={17} strokeWidth={2.2} /></span>
        <span>Relay</span>
        <button className="mobile-close" onClick={() => setMobileOpen(false)} aria-label="Close menu">
          <X size={19} />
        </button>
      </div>

      <div className="workspace-switcher">
        <span className="workspace-avatar">H</span>
        <span className="workspace-switcher-copy">
          <small>Workspace</small>
          <strong>HackRice launch</strong>
        </span>
        <ChevronDown size={16} />
      </div>

      <nav className="primary-nav" aria-label="Workspace navigation">
        {navItems.map(({ label, path, icon: Icon, end }) => (
          <NavLink
            key={label}
            to={`${basePath}${path}`}
            end={end}
            onClick={() => setMobileOpen(false)}
          >
            <Icon size={18} />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="sidebar-spacer" />
      <div className="workspace-health">
        <CheckCircle2 size={16} />
        <div>
          <strong>Workspace is saved</strong>
          <span>All changes are up to date</span>
        </div>
      </div>
      <NavLink className="settings-link" to={`${basePath}/settings`} onClick={() => setMobileOpen(false)}>
        <Settings size={18} />
        <span>Workspace settings</span>
      </NavLink>
      <div className="guest-chip">
        <span className="guest-avatar">GC</span>
        <span><strong>Guest Cedar</strong><small>Contributor</small></span>
      </div>
    </>
  );

  return (
    <div className="app-layout">
      <aside className="sidebar">{sidebar}</aside>
      {mobileOpen && <button className="scrim" onClick={() => setMobileOpen(false)} aria-label="Close menu" />}
      <aside className={`mobile-sidebar ${mobileOpen ? 'is-open' : ''}`}>{sidebar}</aside>

      <div className="app-main">
        <header className="topbar">
          <button className="icon-button menu-button" onClick={() => setMobileOpen(true)} aria-label="Open menu">
            <Menu size={20} />
          </button>
          <div className="topbar-title">
            <span className="live-dot" />
            <span>4 collaborators here</span>
          </div>
          <div className="topbar-actions">
            <div className="avatar-stack" aria-label="Collaborators">
              <span>GC</span><span>GJ</span><span>GS</span><span>+1</span>
            </div>
            {onNewTask && (
              <button className="button button-primary compact" onClick={onNewTask}>
                <Plus size={17} /> New task
              </button>
            )}
            {!onNewTask && (
              <button className="button button-secondary compact" onClick={() => navigate(basePath)}>
                Back to tasks
              </button>
            )}
          </div>
        </header>
        <main className="page-content">{children}</main>
      </div>
    </div>
  );
}
