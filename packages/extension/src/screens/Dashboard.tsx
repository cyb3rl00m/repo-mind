import { formatTokens } from '@repomind/core';
import { useStore } from '../lib/store';
import { Badge, Button, Card, Empty, Icon, Stat } from '../components/ui';
import { timeAgo } from '../lib/util';

export function Dashboard() {
  const s = useStore();
  const a = s.active;
  const es = s.engineState;
  const indexing = s.projects.filter((p) => p.status === 'indexing' || p.status === 'error');
  return (
    <div className="stack">
      {a ? (
        <Card
          title={a.project.name}
          subtitle={`${a.project.source === 'github' ? `GitHub · ${a.project.github?.ref} @ ${a.project.github?.sha.slice(0, 10)}` : a.project.source === 'local-engine' ? `Local · ${a.project.engine?.root}` : 'Browser folder (read-only)'} · indexed ${timeAgo(a.project.indexedAt)}`}
          actions={<Button small icon="refresh" onClick={() => void s.reindex(a.project.id)}>Refresh</Button>}
        >
          <div className="stats">
            <Stat label="Files" value={a.index.stats.indexedFiles} />
            <Stat label="Lines" value={a.index.stats.totalLines.toLocaleString()} />
            <Stat label="Symbols" value={Object.keys(a.index.symbolIndex).length.toLocaleString()} />
            <Stat label="Edges" value={a.index.edges.length} />
            <Stat label="≈ Tokens" value={formatTokens(a.project.stats?.tokens ?? 0)} hint="Estimated, heuristic" />
            <Stat label="Tasks" value={a.tasks.length} />
          </div>
          <div className="row">
            <Button variant="primary" icon="context" onClick={() => s.setScreen('context')}>Build context</Button>
            <Button icon="workflow" onClick={() => s.setScreen('workflow')}>Workflow</Button>
            <Button icon="patch" onClick={() => s.setScreen('patch')}>Review a patch</Button>
            <Button icon="external" onClick={() => chrome.tabs.create({ url: s.settings.deepseekUrl })}>Open DeepSeek</Button>
          </div>
        </Card>
      ) : (
        <Card>
          <Empty title="Welcome to RepoMind" action={<Button variant="primary" icon="plus" onClick={() => s.setScreen('repos')}>Add a repository</Button>}>
            Index a GitHub repository or a local folder. RepoMind builds the context, impact analysis and verification around DeepSeek Web — you stay in control of every prompt, patch and command.
          </Empty>
        </Card>
      )}

      <div className="grid-2">
        <Card title="Local engine" actions={es.status !== 'connected' && <Button small icon="refresh" onClick={() => void s.connectEngine()}>Connect</Button>}>
          {es.status === 'connected' ? (
            <div className="stack-sm">
              <div className="row"><Badge tone="ok">connected</Badge><span className="muted small">v{es.info.engineVersion} · {es.info.platform}/{es.info.arch} · Node {es.info.node}</span></div>
              <div className="row gap-xs">
                {Object.entries(es.info.capabilities).map(([k, v]) => <Badge key={k} tone={v ? 'accent' : 'neutral'}>{k}{v ? '' : ' ✕'}</Badge>)}
              </div>
            </div>
          ) : (
            <p className="muted small">{es.status === 'connecting' ? 'Connecting…' : es.error ?? 'Not connected. Local folders, git safety and build/test need the engine; GitHub import and prompts work without it.'}</p>
          )}
        </Card>
        <Card title="Indexing status">
          {indexing.length === 0 ? (
            <p className="muted small">{s.projects.length} project(s), all indexed.</p>
          ) : (
            <ul className="plain">
              {indexing.map((p) => (
                <li key={p.id} className="row nowrap">
                  {p.status === 'indexing' ? <span className="spinner" /> : <Icon name="warn" />}
                  <span className="truncate grow">{p.name}</span>
                  {p.status === 'error' && <Button small onClick={() => void s.reindex(p.id)}>Retry</Button>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="Recent projects" actions={<Button small icon="plus" onClick={() => s.setScreen('repos')}>Add</Button>}>
        {s.projects.length === 0 ? (
          <p className="muted small">None yet.</p>
        ) : (
          <div className="list">
            {s.projects.slice(0, 8).map((p) => (
              <div key={p.id} className={`list-item clickable ${a?.project.id === p.id ? 'selected' : ''}`} onClick={() => p.status === 'ready' && void s.openProject(p.id)}>
                <Icon name={p.source === 'github' ? 'github' : 'folder'} />
                <span className="grow truncate">{p.name}</span>
                <span className="muted small">{p.stats ? `${p.stats.files} files` : ''}</span>
                <Badge tone={p.status === 'ready' ? 'ok' : p.status === 'error' ? 'bad' : 'warn'}>{p.status}</Badge>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Recent activity">
        {s.activity.length === 0 ? (
          <p className="muted small">Nothing yet.</p>
        ) : (
          <ul className="plain">
            {s.activity.slice(0, 12).map((x) => (
              <li key={x.id} className="row nowrap small">
                <Badge tone={x.kind === 'error' ? 'bad' : 'neutral'}>{x.kind}</Badge>
                <span className="grow truncate" title={x.text}>{x.text}</span>
                <span className="muted">{timeAgo(x.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
