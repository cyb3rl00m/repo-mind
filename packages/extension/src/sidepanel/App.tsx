import type { ReactNode } from 'react';
import { useStore, type Screen } from '../lib/store';
import { Icon } from '../components/ui';
import { Dashboard } from '../screens/Dashboard';
import { Repositories } from '../screens/Repositories';
import { Explorer } from '../screens/Explorer';
import { Brain } from '../screens/Brain';
import { ContextBuilder } from '../screens/ContextBuilder';
import { Workflow } from '../screens/Workflow';
import { PatchReview } from '../screens/PatchReview';
import { BuildTest } from '../screens/BuildTest';
import { MemoryCenter } from '../screens/MemoryCenter';
import { SettingsScreen } from '../screens/Settings';
import { openUrl } from '../lib/util';

const NAV: { id: Screen; label: string; icon: string; needsProject?: boolean }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
  { id: 'repos', label: 'Repositories', icon: 'repos' },
  { id: 'explorer', label: 'Explorer', icon: 'explorer', needsProject: true },
  { id: 'brain', label: 'Project Brain', icon: 'brain', needsProject: true },
  { id: 'context', label: 'Context Builder', icon: 'context', needsProject: true },
  { id: 'workflow', label: 'Workflow', icon: 'workflow', needsProject: true },
  { id: 'patch', label: 'Patch Review', icon: 'patch', needsProject: true },
  { id: 'build', label: 'Build & Test', icon: 'build', needsProject: true },
  { id: 'memory', label: 'Memory', icon: 'memory', needsProject: true },
  { id: 'settings', label: 'Settings', icon: 'settings' }
];

export function App() {
  const s = useStore();
  if (!s.ready) return <div className="boot"><span className="spinner" /> Loading RepoMind…</div>;
  const current = NAV.find((n) => n.id === s.screen)!;
  const blocked = current.needsProject && !s.active;
  let body: ReactNode;
  if (blocked) body = <NoProject />;
  else
    body = {
      dashboard: <Dashboard />,
      repos: <Repositories />,
      explorer: <Explorer />,
      brain: <Brain />,
      context: <ContextBuilder />,
      workflow: <Workflow />,
      patch: <PatchReview />,
      build: <BuildTest />,
      memory: <MemoryCenter />,
      settings: <SettingsScreen />
    }[s.screen];

  const es = s.engineState;
  return (
    <div className="shell">
      <nav className="rail" aria-label="Main">
        <div className="logo" title="RepoMind">
          <img src="icons/icon32.png" alt="" width={22} height={22} />
        </div>
        {NAV.map((n) => (
          <button key={n.id} className={`rail-btn ${s.screen === n.id ? 'active' : ''}`} onClick={() => s.setScreen(n.id)} title={n.label} aria-label={n.label} aria-current={s.screen === n.id}>
            <Icon name={n.icon} size={18} />
          </button>
        ))}
        <div className="rail-spacer" />
        <button className="rail-btn" title="Open RepoMind in a full tab" aria-label="Open in tab" onClick={() => openUrl(chrome.runtime.getURL('sidepanel.html?tab=1'))}>
          <Icon name="tab" size={18} />
        </button>
      </nav>
      <div className="main">
        <header className="topbar">
          <div className="topbar-title">
            <h1>{current.label}</h1>
            <select
              className="input project-select"
              value={s.active?.project.id ?? ''}
              onChange={(e) => e.target.value && void s.openProject(e.target.value)}
              aria-label="Active project"
            >
              <option value="">{s.projects.length ? 'Select project…' : 'No projects yet'}</option>
              {s.projects.filter((p) => p.status === 'ready').map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <button
            className={`engine-pill ${es.status}`}
            onClick={() => (es.status === 'connected' ? s.setScreen('settings') : void s.connectEngine())}
            title={es.status === 'connected' ? `Local engine ${es.info.engineVersion} (protocol v${es.info.protocol})` : es.status === 'disconnected' ? es.error ?? 'Local engine not connected — click to connect' : 'Connecting…'}
          >
            <span className="dot" />
            {es.status === 'connected' ? 'Engine' : es.status === 'connecting' ? 'Connecting' : 'No engine'}
          </button>
        </header>
        {s.busy && (
          <div className="busy" role="status">
            <span className="spinner" />
            <strong>{s.busy.label}</strong>
            {s.busy.detail && <span className="muted"> — {s.busy.detail}</span>}
          </div>
        )}
        <main className="content">{s.activeLoading ? <div className="boot"><span className="spinner" /> Loading project…</div> : body}</main>
      </div>
      <div className="toasts" aria-live="polite">
        {s.toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function NoProject() {
  const s = useStore();
  return (
    <div className="empty">
      <h3>No project open</h3>
      <p className="muted">Import a GitHub repository or open a local folder to use this screen.</p>
      <button className="btn btn-primary" onClick={() => s.setScreen('repos')}>
        Go to Repositories
      </button>
    </div>
  );
}
