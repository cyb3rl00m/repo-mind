import { useEffect, useMemo, useState } from 'react';
import { analyzeRegression, formatUnifiedDiff, parseUnifiedDiff, validatePatchPaths, type EngineMethods, type FindingCategory } from '@repomind/core';
import { useActive, useStore } from '../lib/store';
import { Badge, Button, Card, Confirm, DiffView, Empty, SeverityBadge, Tabs, TextArea } from '../components/ui';
import { PathLabel } from '../components/PathLabel';
import { engine } from '../lib/engine';
import { responseToDiff } from '../lib/patches';
import { copyText, downloadText, rid } from '../lib/util';

type CheckResult = EngineMethods['patch.check']['result'];

export function PatchReview() {
  const s = useStore();
  const a = useActive();
  const [input, setInput] = useState(s.patchDraft?.diff ?? '');
  const [inputKind, setInputKind] = useState<'diff' | 'response'>('diff');
  const [diff, setDiff] = useState(s.patchDraft?.diff ?? '');
  const [notes, setNotes] = useState<string[]>([]);
  const [fileIdx, setFileIdx] = useState(0);
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [allowDeletes, setAllowDeletes] = useState(false);
  const [allowDirty, setAllowDirty] = useState(false);
  const [lastApplied, setLastApplied] = useState<string | null>(null);
  const task = s.patchDraft?.taskId ? a.tasks.find((t) => t.id === s.patchDraft!.taskId) : undefined;
  const isLocal = a.project.source === 'local-engine' && s.engineState.status === 'connected';

  useEffect(() => {
    if (s.patchDraft?.diff && s.patchDraft.diff !== diff) {
      setInput(s.patchDraft.diff);
      setDiff(s.patchDraft.diff);
      setCheck(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.patchDraft]);

  const parsed = useMemo(() => (diff.trim() ? parseUnifiedDiff(diff) : null), [diff]);
  const pathIssues = useMemo(() => (parsed ? validatePatchPaths(parsed, { knownFiles: new Set(Object.keys(a.index.files)), allowDeletes }) : []), [parsed, a.index, allowDeletes]);
  const regression = useMemo(() => (parsed && parsed.files.length ? analyzeRegression(parsed, a.index, a.contents, { expectedFiles: task?.plan?.files }) : null), [parsed, a.index, a.contents, task]);
  const normalized = useMemo(() => (parsed?.files.length ? formatUnifiedDiff(parsed) : ''), [parsed]);
  const errors = [...(parsed?.issues ?? []), ...pathIssues].filter((i) => i.severity === 'error');

  const load = () => {
    if (inputKind === 'response') {
      const r = responseToDiff(input, a);
      setDiff(r.diff);
      setNotes(r.notes);
    } else {
      setDiff(input);
      setNotes([]);
    }
    setFileIdx(0);
    setCheck(null);
  };

  const runCheck = async () => {
    if (!a.project.engine) return;
    setChecking(true);
    try {
      setCheck(await engine.call('patch.check', { projectId: a.project.engine.projectId, diff: normalized, allowDeletes }));
    } catch (e) {
      s.toast((e as Error).message, 'error');
    } finally {
      setChecking(false);
    }
  };

  const updateTaskPatch = async (status: 'applied' | 'rejected' | 'reverted' | 'failed', checkpoint?: string | null) => {
    if (!task) return;
    const existing = task.patches.find((p) => p.diff === diff || p.diff === normalized);
    const summary = regression ? { summary: regression.summary, checklist: regression.checklist, findingCount: regression.findings.length } : undefined;
    const rec = existing
      ? { ...existing, status, regression: summary, checkpoint: checkpoint ?? existing.checkpoint, appliedAt: status === 'applied' ? new Date().toISOString() : existing.appliedAt }
      : { id: rid('p'), source: s.patchDraft?.source ?? 'manual', diff: normalized, createdAt: new Date().toISOString(), status, regression: summary, checkpoint: checkpoint ?? undefined };
    await s.saveTask({ ...task, patches: existing ? task.patches.map((p) => (p.id === existing.id ? rec : p)) : [...task.patches, rec], stage: status === 'applied' && task.stage !== 'verify' ? 'verify' : task.stage });
  };

  const apply = async () => {
    try {
      const r = await engine.call('patch.apply', { projectId: a.project.engine!.projectId, diff: normalized, approved: true, allowDeletes, allowDirtyOverlap: allowDirty });
      s.toast(`Applied to ${r.files.length} file(s)${r.checkpoint ? ` · checkpoint ${r.checkpoint.slice(0, 10)}` : ''}`, 'success');
      s.log('patch', `Applied patch to ${r.files.join(', ')} (${r.method})`);
      setLastApplied(normalized);
      await updateTaskPatch('applied', r.checkpoint);
      setConfirm(false);
      await s.reindex(a.project.id);
    } catch (e) {
      s.toast((e as Error).message, 'error');
      setConfirm(false);
    }
  };

  const revert = async () => {
    try {
      const r = await engine.call('patch.revert', { projectId: a.project.engine!.projectId, diff: lastApplied ?? normalized, approved: true });
      s.toast(r.reverted ? 'Patch reverted.' : r.output, r.reverted ? 'success' : 'error');
      s.log('patch', 'Reverted a patch');
      await updateTaskPatch('reverted');
      setLastApplied(null);
      await s.reindex(a.project.id);
    } catch (e) {
      s.toast((e as Error).message, 'error');
    }
  };

  const file = parsed?.files[fileIdx];
  const byCat = (regression?.findings ?? []).reduce<Partial<Record<FindingCategory, number>>>((acc, f) => ((acc[f.category] = (acc[f.category] ?? 0) + 1), acc), {});

  return (
    <div className="stack">
      <Card title="Patch input" subtitle={task ? `Linked to task “${task.title}”` : 'Paste a unified diff, or a full DeepSeek answer.'}>
        <Tabs value={inputKind} onChange={setInputKind} options={[{ id: 'diff', label: 'Unified diff' }, { id: 'response', label: 'DeepSeek response' }]} />
        <TextArea rows={7} value={input} onChange={(e) => setInput(e.target.value)} placeholder={inputKind === 'diff' ? 'diff --git a/… b/…' : 'Paste the whole answer; ```diff blocks and FILE: blocks are extracted.'} />
        <div className="row">
          <Button variant="primary" disabled={!input.trim()} onClick={load}>Analyze</Button>
          {diff && <Button variant="ghost" onClick={() => { setInput(''); setDiff(''); s.setPatchDraft(null); setCheck(null); }}>Clear</Button>}
        </div>
        {notes.map((n) => <div key={n} className={`callout ${n.startsWith('error') ? 'bad' : n.startsWith('warning') ? 'warn' : ''}`}>{n}</div>)}
      </Card>

      {!parsed ? (
        <Card><Empty title="No patch loaded">RepoMind validates syntax and paths, simulates the patch against the indexed code and flags regressions before anything touches your files.</Empty></Card>
      ) : (
        <>
          <Card
            title={<span className="row nowrap">Assessment {regression && <Badge tone={regression.summary.verdict === 'blocked' ? 'bad' : regression.summary.verdict === 'review-carefully' ? 'warn' : 'ok'}>{regression.summary.verdict}</Badge>}</span>}
            subtitle="Findings are heuristics, not proven bugs. Each explains why it was raised."
          >
            <div className="row gap-xs">
              <Badge tone="bad">{regression?.summary.high ?? 0} high</Badge>
              <Badge tone="warn">{regression?.summary.medium ?? 0} medium</Badge>
              <Badge tone="info">{regression?.summary.low ?? 0} low</Badge>
              {Object.entries(byCat).map(([c, n]) => <Badge key={c}>{c}: {n}</Badge>)}
            </div>
            {errors.map((i, k) => <div key={k} className="callout bad">{i.path ? <strong className="mono">{i.path}: </strong> : null}{i.message}</div>)}
            {[...parsed.issues, ...pathIssues].filter((i) => i.severity === 'warning').map((i, k) => <div key={`w${k}`} className="callout warn">{i.path ? <strong className="mono">{i.path}: </strong> : null}{i.message}</div>)}
            {regression && regression.findings.length > 0 && (
              <div className="list">
                {regression.findings.map((f, i) => (
                  <details key={i} className="list-item" style={{ display: 'block' }}>
                    <summary className="row nowrap">
                      <SeverityBadge s={f.severity} />
                      <span className="grow truncate">{f.title}</span>
                      <span className="muted small mono truncate" style={{ maxWidth: 160 }}>{f.path.split('/').pop()}{f.line ? `:${f.line}` : ''}</span>
                    </summary>
                    <div className="small muted" style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{f.category} · {f.path}{f.line ? `:${f.line}` : ''}{'\n'}{f.explanation}</div>
                  </details>
                ))}
              </div>
            )}
            {regression && (
              <details open>
                <summary className="small"><strong>Regression checklist</strong></summary>
                <ul className="bullets small">{regression.checklist.map((c) => <li key={c}>{c}</li>)}</ul>
              </details>
            )}
          </Card>

          <Card title={`Changed files (${parsed.files.length})`}>
            <div className="list">
              {parsed.files.map((f, i) => {
                const fc = regression?.filesChanged.find((x) => x.path === f.path);
                return (
                  <div key={i} className={`list-item clickable ${i === fileIdx ? 'selected' : ''}`} onClick={() => setFileIdx(i)}>
                    <Badge tone={f.status === 'deleted' ? 'bad' : f.status === 'added' ? 'ok' : 'neutral'}>{f.status}</Badge>
                    <PathLabel path={f.path} />
                    <span className="grow" />
                    {fc && !fc.applies && <Badge tone="bad">does not apply</Badge>}
                    {fc?.fuzzy && <Badge tone="warn">fuzz</Badge>}
                    <span className="mono small" style={{ color: 'var(--ok)' }}>+{f.additions}</span>
                    <span className="mono small" style={{ color: 'var(--bad)' }}>−{f.deletions}</span>
                  </div>
                );
              })}
            </div>
            {file && <DiffView file={file} />}
          </Card>

          <Card title="Validation & application">
            {isLocal ? (
              <>
                <div className="row">
                  <Button icon="check" busy={checking} disabled={!normalized} onClick={() => void runCheck()}>Validate with git apply --check</Button>
                  <label className="check"><input type="checkbox" checked={allowDeletes} onChange={(e) => setAllowDeletes(e.target.checked)} /><span>Allow file deletions</span></label>
                </div>
                {check && (
                  <div className={`callout ${check.ok ? 'ok' : 'bad'}`}>
                    <strong>{check.ok ? 'Patch applies cleanly.' : 'Patch cannot be applied.'}</strong>
                    {check.issues.filter((i) => i.severity === 'error').map((i, k) => <div key={k}>{i.path ? `${i.path}: ` : ''}{i.message}</div>)}
                    {check.dirtyOverlap.length > 0 && <div>Uncommitted local changes in: <span className="mono">{check.dirtyOverlap.join(', ')}</span></div>}
                    {check.gitCheck.output && <pre className="terminal" style={{ marginTop: 6 }}>{check.gitCheck.output}</pre>}
                  </div>
                )}
                <div className="row">
                  <Button variant="primary" icon="play" disabled={!check?.ok || errors.length > 0} onClick={() => setConfirm(true)}>Apply patch…</Button>
                  {lastApplied && <Button icon="refresh" onClick={() => void revert()}>Revert applied patch</Button>}
                  {task && <Button variant="ghost" onClick={() => void updateTaskPatch('rejected').then(() => s.toast('Patch marked as rejected.'))}>Reject</Button>}
                </div>
                <p className="muted small">Applying creates a git checkpoint (refs/repomind/checkpoints/…) without touching your working tree first. RepoMind never commits or pushes.</p>
              </>
            ) : (
              <div className="callout">
                {a.project.source === 'local-engine'
                  ? 'Connect the local engine to validate and apply patches.'
                  : 'This project is a snapshot (GitHub or browser folder). Export the patch and apply it in your local checkout with `git apply --check file.patch && git apply file.patch`, or open the folder through the local engine.'}
              </div>
            )}
            <div className="row">
              <Button icon="download" disabled={!normalized} onClick={() => downloadText(`repomind-${Date.now()}.patch`, normalized, 'text/x-diff')}>Export .patch</Button>
              <Button variant="ghost" icon="copy" disabled={!normalized} onClick={() => void copyText(normalized).then(() => s.toast('Normalized diff copied.'))}>Copy normalized diff</Button>
            </div>
          </Card>
        </>
      )}

      {confirm && parsed && (
        <Confirm title="Apply this patch?" confirmLabel="Apply" onCancel={() => setConfirm(false)} onConfirm={apply}>
          <p>The following files in <span className="mono">{a.project.engine?.root}</span> will be modified:</p>
          <ul className="plain small mono">{parsed.files.map((f) => <li key={f.path}>{f.status} {f.path} (+{f.additions} −{f.deletions})</li>)}</ul>
          {(regression?.summary.high ?? 0) > 0 && <div className="callout bad">{regression!.summary.high} high-severity finding(s) are open.</div>}
          {check?.dirtyOverlap.length ? (
            <label className="check"><input type="checkbox" checked={allowDirty} onChange={(e) => setAllowDirty(e.target.checked)} /><span>Apply on top of my uncommitted changes in {check.dirtyOverlap.join(', ')}</span></label>
          ) : null}
        </Confirm>
      )}
    </div>
  );
}
