import { useState } from 'react';
import { parseGitHubUrl } from '@repomind/core';
import { useStore } from '../lib/store';
import { Badge, Button, Card, Confirm, Field, Icon, Kv } from '../components/ui';
import { engine } from '../lib/engine';
import { browserFolderSupported } from '../lib/localFolder';
import { timeAgo } from '../lib/util';
import type { Project } from '../lib/types';

export function Repositories() {
  const s = useStore();
  const engineOk = s.engineState.status === 'connected';
  const [url, setUrl] = useState('');
  const [ref, setRef] = useState('');
  const [priv, setPriv] = useState(false);
  const [viaEngine, setViaEngine] = useState(engineOk);
  const [localPath, setLocalPath] = useState('');
  const [toRemove, setToRemove] = useState<Project | null>(null);
  const parsed = url ? parseGitHubUrl(url) : null;
  const busy = Boolean(s.busy);

  return (
    <div className="stack">
      <Card title="Import from GitHub" subtitle="Downloads one snapshot (zip) of the selected commit. Nothing is uploaded anywhere.">
        <Field label="Repository URL" hint={url && !parsed ? 'Not a recognizable GitHub repository URL.' : parsed ? `${parsed.owner}/${parsed.repo}${parsed.ref ? ` · ref ${parsed.ref}` : ''}${parsed.subPath ? ` · path ${parsed.subPath}` : ''}` : 'https://github.com/owner/repo, owner/repo or git@github.com:owner/repo.git'}>
          <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/owner/repo" />
        </Field>
        <Field label="Branch, tag or commit (optional)" hint="Leave empty for the default branch.">
          <input className="input" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="main" />
        </Field>
        <label className="check">
          <input type="checkbox" checked={priv} onChange={(e) => setPriv(e.target.checked)} />
          <span>Private repository — use my read-only token {engineOk ? '(from the system keyring via the engine)' : '(session token from Settings)'}</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={viaEngine && engineOk} disabled={!engineOk} onChange={(e) => setViaEngine(e.target.checked)} />
          <span>Download through the local engine {engineOk ? '' : '(engine not connected)'}</span>
        </label>
        <div className="row">
          <Button variant="primary" icon="github" disabled={!parsed || busy} onClick={() => void s.importGithub({ url, ref: ref.trim() || undefined, usePrivate: priv, viaEngine: viaEngine && engineOk })}>
            Import & index
          </Button>
        </div>
      </Card>

      <Card title="Open a local folder" subtitle="Full features: live files, git status, checkpoints, worktrees, patch application and build/test.">
        {!engineOk && <div className="callout warn">The local engine is not connected. {s.engineState.status === 'disconnected' && s.engineState.error}</div>}
        <div className="row nowrap">
          <input className="input grow" value={localPath} onChange={(e) => setLocalPath(e.target.value)} placeholder="/home/you/AndroidStudioProjects/MyApp" disabled={!engineOk} />
          <Button icon="folder" disabled={!engineOk || busy} onClick={() => void s.importLocalEngine(localPath || undefined)}>
            {localPath ? 'Open' : 'Pick…'}
          </Button>
        </div>
        {browserFolderSupported() && (
          <div className="row">
            <Button variant="ghost" small icon="folder" disabled={busy} onClick={() => void s.importBrowserFolder()}>
              Browser folder (read-only, no engine)
            </Button>
            <span className="muted small">Indexing and prompts only — no git, patches or builds.</span>
          </div>
        )}
      </Card>

      <Card title={`Projects (${s.projects.length})`}>
        {s.projects.length === 0 && <p className="muted small">No projects yet.</p>}
        <div className="stack-sm">
          {s.projects.map((p) => (
            <ProjectRow key={p.id} p={p} onRemove={() => setToRemove(p)} />
          ))}
        </div>
      </Card>

      {toRemove && (
        <Confirm
          title="Remove project from RepoMind?"
          confirmLabel="Remove"
          danger
          onCancel={() => setToRemove(null)}
          onConfirm={async () => {
            await s.removeProject(toRemove.id);
            setToRemove(null);
          }}
        >
          <p>This deletes RepoMind’s index, snapshot, memory and tasks for <strong>{toRemove.name}</strong>. Your repository files are not touched.</p>
        </Confirm>
      )}
    </div>
  );
}

function ProjectRow({ p, onRemove }: { p: Project; onRemove: () => void }) {
  const s = useStore();
  const [branch, setBranch] = useState(p.github?.ref ?? '');
  const [worktrees, setWorktrees] = useState<{ path: string; branch: string | null; managed: boolean }[] | null>(null);
  const [wtName, setWtName] = useState('');
  const isActive = s.active?.project.id === p.id;
  const engineOk = s.engineState.status === 'connected';
  return (
    <div className={`card subtle`}>
      <div className="row nowrap spread">
        <div className="row nowrap grow">
          <Icon name={p.source === 'github' ? 'github' : 'folder'} />
          <strong className="truncate">{p.name}</strong>
          <Badge tone={p.status === 'ready' ? 'ok' : p.status === 'error' ? 'bad' : 'warn'}>{p.status}</Badge>
          {isActive && <Badge tone="accent">active</Badge>}
        </div>
        <div className="row nowrap gap-xs">
          {!isActive && p.status === 'ready' && <Button small onClick={() => void s.openProject(p.id)}>Open</Button>}
          <Button small icon="refresh" onClick={() => void s.reindex(p.id, { ref: p.source === 'github' ? branch : undefined })} title="Re-download / re-scan and re-index" />
          <Button small variant="ghost" icon="trash" onClick={onRemove} title="Remove" />
        </div>
      </div>
      {p.error && <div className="callout bad">{p.error}</div>}
      <Kv
        rows={[
          ...(p.github
            ? ([
                ['Commit', <span className="mono" key="c">{p.github.sha.slice(0, 12) || '—'} {p.github.commitMessage && <span className="muted">· {p.github.commitMessage}</span>}</span>],
                ['Access', `${p.github.private ? 'private (token)' : 'public'} · via ${p.github.viaEngine ? 'engine' : 'browser'}`]
              ] as [string, React.ReactNode][])
            : []),
          ...(p.engine ? ([['Path', <span className="mono" key="p">{p.engine.root}</span>], ['Git', p.engine.branch ? `${p.engine.branch} @ ${p.engine.head?.slice(0, 10)}${p.engine.dirty ? ` · ${p.engine.dirty} changed files` : ''}` : p.engine.head === undefined ? 'unknown' : 'not a git repository']] as [string, React.ReactNode][]) : []),
          ['Indexed', p.stats ? `${p.stats.files} files, ${p.stats.lines.toLocaleString()} lines, ${p.stats.skipped} skipped · ${timeAgo(p.indexedAt)}` : '—']
        ]}
      />
      {p.github && p.github.branches.length > 0 && (
        <div className="row nowrap">
          <select className="input" value={branch} onChange={(e) => setBranch(e.target.value)} aria-label="Branch">
            {p.github.branches.map((b) => <option key={b}>{b}</option>)}
          </select>
          <Button small icon="branch" disabled={branch === p.github.ref} onClick={() => void s.reindex(p.id, { ref: branch })}>Switch</Button>
        </div>
      )}
      {p.engine && engineOk && (
        <details>
          <summary className="small muted" onClick={() => !worktrees && void engine.call('worktree.list', { projectId: p.engine!.projectId }).then((r) => setWorktrees(r.worktrees)).catch(() => setWorktrees([]))}>
            Isolated worktrees
          </summary>
          <div className="stack-sm" style={{ marginTop: 6 }}>
            <p className="muted small">A worktree is a separate checkout on a new branch <code>repomind/&lt;name&gt;</code>. Apply AI patches there to keep your main checkout untouched.</p>
            {worktrees?.map((w) => (
              <div key={w.path} className="row nowrap small">
                <span className="mono truncate grow" title={w.path}>{w.path}</span>
                <Badge>{w.branch ?? 'detached'}</Badge>
                {w.managed && (
                  <Button small variant="ghost" icon="trash" title="Remove worktree (branch is kept)" onClick={async () => {
                    try {
                      const r = await engine.call('worktree.remove', { projectId: p.engine!.projectId, path: w.path, approved: true });
                      s.toast(r.output, r.removed ? 'success' : 'error');
                      setWorktrees((ws) => ws?.filter((x) => x.path !== w.path) ?? null);
                    } catch (e) {
                      s.toast((e as Error).message, 'error');
                    }
                  }} />
                )}
              </div>
            ))}
            <div className="row nowrap">
              <input className="input grow" placeholder="feature-name" value={wtName} onChange={(e) => setWtName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))} />
              <Button small icon="branch" disabled={!wtName} onClick={async () => {
                try {
                  const r = await engine.call('worktree.create', { projectId: p.engine!.projectId, name: wtName, approved: true });
                  s.toast(`Created ${r.branch} at ${r.path}`, 'success');
                  s.log('task', `Created worktree ${r.branch}`);
                  setWtName('');
                  await s.registerWorktree(r.project);
                } catch (e) {
                  s.toast((e as Error).message, 'error');
                }
              }}>Create worktree</Button>
            </div>
          </div>
        </details>
      )}
    </div>
  );
}
