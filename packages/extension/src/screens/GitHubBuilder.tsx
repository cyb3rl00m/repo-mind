import { useEffect, useMemo, useState } from 'react';
import {
  buildGithubContinuePrompt,
  buildGithubFixPrompt,
  buildGithubModePrompt,
  diffTexts,
  formatTokens,
  formatUnifiedDiff,
  parseGithubMode,
  selectContext,
  validatePublish,
  type GeneratedFile,
  type GithubModeParse,
  type PublishFile,
  type PublishResult
} from '@repomind/core';
import { useActive, useStore } from '../lib/store';
import { Badge, Button, Card, CodeBlock, Confirm, DiffView, Empty, Field, Kv, TextArea } from '../components/ui';
import { PathLabel } from '../components/PathLabel';
import { engine } from '../lib/engine';
import { getSessionToken, publishViaBrowser } from '../lib/github';
import { db } from '../lib/db';
import { identityOf } from '../lib/types';
import { copyText, downloadText, openUrl, timeAgo } from '../lib/util';

interface BuilderSession {
  request: string;
  response: string;
  published: string[];
  remaining: string[];
  history: { at: string; branch: string; commit: string; url: string; files: number; summary?: string }[];
}

const EMPTY_SESSION: BuilderSession = { request: '', response: '', published: [], remaining: [], history: [] };

type Publisher = { kind: 'engine' | 'browser' | 'none'; detail: string };

export function GitHubBuilder() {
  const s = useStore();
  const a = useActive();
  const p = a.project;
  const key = `builder:${p.id}`;
  const [session, setSession] = useState<BuilderSession>(EMPTY_SESSION);
  const [loaded, setLoaded] = useState(false);
  const [maxFiles, setMaxFiles] = useState(12);
  const [parsed, setParsed] = useState<GithubModeParse | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [newBranch, setNewBranch] = useState('');
  const [useNewBranch, setUseNewBranch] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [publisher, setPublisher] = useState<Publisher>({ kind: 'none', detail: 'Checking…' });
  const [last, setLast] = useState<PublishResult | null>(null);

  useEffect(() => {
    void db.get<BuilderSession>('kv', key).then((x) => {
      setSession({ ...EMPTY_SESSION, ...(x ?? {}) });
      setLoaded(true);
    });
  }, [key]);
  const save = (patch: Partial<BuilderSession>) => {
    setSession((cur) => {
      const next = { ...cur, ...patch };
      void db.put('kv', key, next);
      return next;
    });
  };

  // Where will publishing happen?
  useEffect(() => {
    void (async () => {
      if (p.source !== 'github') return;
      if (s.engineState.status === 'connected') {
        const st = await engine.call('secrets.status', {}).catch(() => null);
        if (st?.hasGithubToken) return setPublisher({ kind: 'engine', detail: 'Local engine, token from the system keyring' });
      }
      if (await getSessionToken()) return setPublisher({ kind: 'browser', detail: 'Browser, session token (cleared when the browser closes)' });
      setPublisher({ kind: 'none', detail: 'No GitHub token. Add one with “Contents: Read and write” in Settings → GitHub access.' });
    })();
  }, [p.source, s.engineState.status]);

  const existing = useMemo(() => new Set(Object.keys(a.index.files)), [a.index]);
  const paths = Object.keys(a.index.files);

  const firstPrompt = () => {
    let selection;
    if (paths.length && s.retriever && session.request.trim()) {
      const r = s.retriever.retrieve(session.request);
      selection = selectContext(r.ranked, a.index, a.contents, { budgetTokens: s.settings.budgetTokens, reservedTokens: s.settings.reservedTokens + 3000, manualInclude: p.pinnedInclude, manualExclude: p.pinnedExclude });
    }
    return buildGithubModePrompt({
      identity: { ...identityOf(p), owner: p.github?.owner ?? p.name, repo: p.github?.repo ?? p.name, branch: p.github?.ref ?? p.engine?.branch ?? 'main' },
      index: a.index,
      contents: a.contents,
      memory: a.memory,
      request: session.request,
      selection,
      published: session.published,
      maxFilesPerBatch: maxFiles
    });
  };

  const copyPrompt = async (text: string, tokens: number, label: string) => {
    await copyText(text);
    s.toast(`${label} copied (≈${formatTokens(tokens)} tokens). Paste it into DeepSeek.`, 'success');
    s.log('prompt', `${label} for ${p.name}`);
  };

  const check = () => {
    const r = parseGithubMode(session.response, existing);
    setParsed(r);
    setSelected(new Set(r.files.filter((f) => !f.issues.some((i) => i.severity === 'error')).map((f) => f.path)));
    setPreview(r.files[0]?.path ?? null);
    setMessage(r.summary ? `${r.summary}${r.batch ? ` (batch ${r.batch.n}/${r.batch.total})` : ''}` : session.request.split('\n')[0]!.slice(0, 72) || 'Update from RepoMind GitHub Builder');
  };

  const chosen: GeneratedFile[] = parsed?.files.filter((f) => selected.has(f.path)) ?? [];
  const changes: PublishFile[] = chosen.map((f) => ({ path: f.path, content: f.action === 'delete' ? null : f.content }));
  const blocked = chosen.filter((f) => f.issues.some((i) => i.severity === 'error'));
  const branch = p.github?.ref || 'main';
  const targetBranch = useNewBranch && newBranch.trim() ? newBranch.trim() : undefined;
  const publishProblems = parsed ? validatePublish({ files: changes, message, branch, newBranch: targetBranch }) : [];

  const publish = async () => {
    if (!p.github) return;
    const opts = { owner: p.github.owner, repo: p.github.repo, branch, newBranch: targetBranch, message, files: changes, expectedHead: p.github.sha || null };
    try {
      const progress = (m: string) => s.toast(m);
      const result =
        publisher.kind === 'engine'
          ? await engine.call('github.publish', { ...opts, approved: true }, { onEvent: (e) => e.data.message && progress(e.data.message) })
          : await publishViaBrowser(opts, progress);
      setLast(result);
      setConfirm(false);
      const published = [...new Set([...session.published, ...changes.filter((c) => c.content !== null).map((c) => c.path)])].filter((x) => !changes.some((c) => c.content === null && c.path === x));
      save({
        published,
        remaining: parsed?.remaining ?? [],
        response: '',
        history: [{ at: new Date().toISOString(), branch: result.branch, commit: result.commitSha, url: result.htmlUrl, files: changes.length, summary: parsed?.summary }, ...session.history].slice(0, 50)
      });
      setParsed(null);
      s.toast(`Published ${changes.length} file(s) to ${result.branch} (${result.commits} commit${result.commits > 1 ? 's' : ''}).`, 'success');
      await s.applyPublished(p.id, changes, result);
    } catch (e) {
      setConfirm(false);
      s.toast((e as Error).message, 'error');
      s.log('error', `Publish failed: ${(e as Error).message}`);
    }
  };

  const toPatchReview = () => {
    const diff = formatUnifiedDiff(chosen.map((f) => diffTexts(f.path, a.contents.get(f.path) ?? null, f.action === 'delete' ? null : f.content)));
    s.setPatchDraft({ diff, source: 'deepseek' });
    s.setScreen('patch');
  };

  if (!loaded) return null;
  const previewFile = parsed?.files.find((f) => f.path === preview);

  return (
    <div className="stack">
      <Card
        title="GitHub Builder"
        subtitle="Build or change the app with DeepSeek in GITHUB MODE. DeepSeek writes complete files; RepoMind checks them and — after you approve — commits them to the repository."
      >
        {p.source === 'github' ? (
          <Kv
            rows={[
              ['Repository', <span key="r" className="mono">{p.github!.owner}/{p.github!.repo}</span>],
              ['Branch', <span key="b" className="mono">{branch}</span>],
              ['Commit', p.github!.empty || !p.github!.sha ? <Badge key="c" tone="info">empty repository</Badge> : <span key="c" className="mono">{p.github!.sha.slice(0, 10)}</span>],
              ['Files', String(paths.length)],
              ['Publishing', <span key="p">{publisher.kind === 'none' ? <Badge tone="warn">no token</Badge> : <Badge tone="ok">{publisher.kind}</Badge>} <span className="muted small">{publisher.detail}</span></span>]
            ]}
          />
        ) : (
          <div className="callout">
            This project is {p.source === 'local-engine' ? 'a local folder' : 'a browser folder'}. GitHub Builder can generate and check files here; {p.source === 'local-engine' ? 'apply them through Patch Review.' : 'export them as a .patch.'} To publish directly, import the repository from GitHub.
          </div>
        )}
        {publisher.kind === 'none' && p.source === 'github' && (
          <div className="row">
            <Button small onClick={() => s.setScreen('settings')}>Add a write token</Button>
            <span className="muted small">Fine-grained token → this repository only → Contents: Read and write.</span>
          </div>
        )}
      </Card>

      <Card title="1 · Tell DeepSeek what to build" subtitle={paths.length ? 'RepoMind adds the repository tree, memory and the relevant files.' : 'The repository is empty: DeepSeek will first plan every file, then write them in batches.'}>
        <TextArea rows={5} value={session.request} onChange={(e) => save({ request: e.target.value })} placeholder="e.g. Build an Android todo app in Kotlin with Jetpack Compose, Room for storage, add/edit/delete/complete tasks, dark theme. Package com.cyb3rl00m.todo, minSdk 26." />
        <div className="row">
          <Field label="Files per answer">
            <select className="input" style={{ width: 90 }} value={maxFiles} onChange={(e) => setMaxFiles(Number(e.target.value))}>
              {[6, 8, 12, 16, 20].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </Field>
        </div>
        <div className="row">
          <Button variant="primary" icon="copy" disabled={!session.request.trim()} onClick={() => { const pr = firstPrompt(); void copyPrompt(pr.text, pr.tokens, 'GITHUB MODE prompt'); }}>Copy GITHUB MODE prompt</Button>
          <Button icon="external" onClick={() => openUrl(s.settings.deepseekUrl)}>Open DeepSeek</Button>
          <Button variant="ghost" icon="copy" disabled={!session.published.length && !session.remaining.length} onClick={() => { const pr = buildGithubContinuePrompt({ published: session.published, remaining: session.remaining, maxFilesPerBatch: maxFiles }); void copyPrompt(pr.text, pr.tokens, '“Continue” prompt'); }}>Copy “continue” prompt</Button>
        </div>
        {session.remaining.length > 0 && <div className="callout">Still to write ({session.remaining.length}): <span className="mono small">{session.remaining.slice(0, 12).join(', ')}{session.remaining.length > 12 ? ' …' : ''}</span></div>}
      </Card>

      <Card title="2 · Paste DeepSeek’s answer">
        <TextArea rows={8} value={session.response} onChange={(e) => save({ response: e.target.value })} placeholder="Paste the complete answer (all === FILE blocks and the status block)." />
        <div className="row">
          <Button variant="primary" icon="check" disabled={!session.response.trim()} onClick={check}>Check files</Button>
          {session.response && <Button variant="ghost" onClick={() => { save({ response: '' }); setParsed(null); }}>Clear</Button>}
        </div>
      </Card>

      {parsed && (
        <Card title={`3 · Review (${parsed.files.length} file${parsed.files.length === 1 ? '' : 's'})`} subtitle={parsed.summary ? `DeepSeek: ${parsed.summary}${parsed.batch ? ` — batch ${parsed.batch.n}/${parsed.batch.total}` : ''}` : undefined}>
          {parsed.issues.map((i) => <div key={i} className={`callout ${parsed.truncated || /No file blocks/.test(i) ? 'bad' : 'warn'}`}>{i}</div>)}
          {parsed.files.length > 0 && (
            <div className="list">
              {parsed.files.map((f) => {
                const err = f.issues.some((i) => i.severity === 'error');
                return (
                  <div key={f.path} className={`list-item ${preview === f.path ? 'selected' : ''}`}>
                    <input type="checkbox" checked={selected.has(f.path)} disabled={err} onChange={(e) => setSelected((cur) => { const n = new Set(cur); if (e.target.checked) n.add(f.path); else n.delete(f.path); return n; })} aria-label={`Publish ${f.path}`} />
                    <div className="grow clickable" style={{ minWidth: 0 }} onClick={() => setPreview(f.path)}>
                      <div className="row nowrap">
                        <Badge tone={f.action === 'delete' ? 'bad' : f.action === 'create' ? 'ok' : 'info'}>{f.action}</Badge>
                        <PathLabel path={f.path} />
                      </div>
                      {f.issues.map((i, k) => <div key={k} className="small" style={{ color: i.severity === 'error' ? 'var(--bad)' : 'var(--warn)' }}>{i.message}</div>)}
                    </div>
                    <span className="muted small">{f.type ?? ''}</span>
                    <span className="score">{f.bytes ? `${(f.bytes / 1024).toFixed(1)}k` : ''}</span>
                  </div>
                );
              })}
            </div>
          )}
          {(parsed.truncated || parsed.files.some((f) => f.issues.some((i) => i.severity === 'error'))) && (
            <Button icon="copy" onClick={() => {
              const problems = parsed.files.filter((f) => f.issues.some((i) => i.severity === 'error')).map((f) => ({ path: f.path, messages: f.issues.filter((i) => i.severity === 'error').map((i) => i.message) }));
              const pr = parsed.truncated && !problems.length ? buildGithubContinuePrompt({ published: session.published, remaining: parsed.remaining, note: 'Your last answer was cut off inside a file. Resend that file completely.', maxFilesPerBatch: maxFiles }) : buildGithubFixPrompt(problems);
              void copyPrompt(pr.text, pr.tokens, 'Fix prompt');
            }}>Copy “fix and resend” prompt</Button>
          )}
          {parsed.manualSteps.length > 0 && !(parsed.manualSteps.length === 1 && /^none\.?$/i.test(parsed.manualSteps[0]!)) && (
            <div className="callout warn"><strong>Manual steps from DeepSeek:</strong><ul className="bullets small">{parsed.manualSteps.map((m) => <li key={m}>{m}</li>)}</ul></div>
          )}
          {previewFile && (
            <details open>
              <summary className="small"><strong>{previewFile.path}</strong> — {previewFile.action === 'update' ? 'changes vs. current file' : previewFile.action === 'delete' ? 'will be deleted' : 'new file'}</summary>
              {previewFile.action === 'update' && previewFile.content !== null ? (
                <DiffView file={diffTexts(previewFile.path, a.contents.get(previewFile.path) ?? '', previewFile.content)} />
              ) : previewFile.content !== null ? (
                <CodeBlock code={previewFile.content} maxHeight={420} />
              ) : null}
            </details>
          )}
        </Card>
      )}

      {parsed && parsed.files.length > 0 && (
        <Card title="4 · Publish">
          {p.source === 'github' ? (
            <>
              <Field label="Commit message">
                <input className="input" value={message} onChange={(e) => setMessage(e.target.value)} />
              </Field>
              <label className="check">
                <input type="checkbox" checked={useNewBranch} disabled={!p.github?.sha} onChange={(e) => setUseNewBranch(e.target.checked)} />
                <span>Commit to a new branch instead of <code>{branch}</code> (review it as a pull request on GitHub){!p.github?.sha ? ' — not possible in an empty repository' : ''}</span>
              </label>
              {useNewBranch && <input className="input mono" placeholder="repomind/todo-app" value={newBranch} onChange={(e) => setNewBranch(e.target.value)} />}
              {publishProblems.map((x) => <div key={x} className="callout bad">{x}</div>)}
              <div className="row">
                <Button variant="primary" icon="github" disabled={!changes.length || blocked.length > 0 || publishProblems.length > 0 || publisher.kind === 'none'} onClick={() => setConfirm(true)}>
                  Publish {changes.length} file{changes.length === 1 ? '' : 's'}…
                </Button>
                <Button variant="ghost" icon="download" disabled={!changes.length} onClick={() => downloadText(`repomind-${Date.now()}.patch`, formatUnifiedDiff(chosen.map((f) => diffTexts(f.path, a.contents.get(f.path) ?? null, f.action === 'delete' ? null : f.content))), 'text/x-diff')}>Export .patch</Button>
              </div>
              <p className="muted small">One commit per publish (an empty repository gets two: GitHub requires its first file to be created separately). RepoMind never force-pushes: if the branch changed on GitHub, publishing stops and asks you to refresh.</p>
            </>
          ) : (
            <div className="row">
              {p.source === 'local-engine' && <Button variant="primary" icon="patch" disabled={!changes.length} onClick={toPatchReview}>Review & apply in Patch Review</Button>}
              <Button icon="download" disabled={!changes.length} onClick={() => downloadText(`repomind-${Date.now()}.patch`, formatUnifiedDiff(chosen.map((f) => diffTexts(f.path, a.contents.get(f.path) ?? null, f.action === 'delete' ? null : f.content))), 'text/x-diff')}>Export .patch</Button>
            </div>
          )}
        </Card>
      )}

      {last && (
        <div className="callout ok">
          Published to <code>{last.branch}</code> — commit <code>{last.commitSha.slice(0, 10)}</code>.{' '}
          <a href="#" onClick={(e) => { e.preventDefault(); openUrl(last.htmlUrl); }}>Open on GitHub</a>
          {session.remaining.length ? ' · Next: copy the “continue” prompt for the remaining files.' : ''}
        </div>
      )}

      {session.history.length > 0 && (
        <Card title="Publish history" actions={<Button small variant="ghost" onClick={() => save({ published: [], remaining: [], history: [] })}>Reset build session</Button>}>
          <div className="list">
            {session.history.map((h) => (
              <div key={h.commit} className="list-item">
                <Badge tone="ok">{h.files} files</Badge>
                <span className="grow small truncate">{h.summary ?? h.commit.slice(0, 10)} · {h.branch}</span>
                <span className="muted small">{timeAgo(h.at)}</span>
                <Button small variant="ghost" icon="external" onClick={() => openUrl(h.url)} title="Open commit" />
              </div>
            ))}
          </div>
        </Card>
      )}
      {!parsed && !session.history.length && paths.length === 0 && p.source === 'github' && (
        <Card><Empty title="Empty repository">Describe the app above, copy the prompt into DeepSeek, paste the answer back, check and publish. Repeat with “continue” until REMAINING is empty.</Empty></Card>
      )}

      {confirm && parsed && (
        <Confirm title={`Publish to ${p.github?.owner}/${p.github?.repo}?`} confirmLabel="Publish to GitHub" onCancel={() => setConfirm(false)} onConfirm={publish}>
          <p>
            One commit “{message}” on <code>{targetBranch ?? branch}</code>{targetBranch ? <> (new branch from <code>{branch}</code>)</> : null}:
          </p>
          <ul className="plain small mono">{chosen.map((f) => <li key={f.path}>{f.action} {f.path}</li>)}</ul>
          {chosen.some((f) => f.action === 'delete') && <div className="callout warn">This deletes files on GitHub.</div>}
          {chosen.some((f) => f.issues.length) && <div className="callout warn">Some files have warnings. Check them before publishing.</div>}
          <p className="muted small">This writes to GitHub immediately. You can undo it on GitHub by reverting the commit.</p>
        </Confirm>
      )}
    </div>
  );
}
