import { useMemo, useState } from 'react';
import {
  MODES,
  STAGE_LABELS,
  addEntry,
  analyzeLog,
  analyzeRegression,
  buildCompletionReport,
  extractAcceptanceCriteria,
  extractPlanFiles,
  extractSuggestions,
  extractUnits,
  formatTokens,
  parseUnifiedDiff,
  stageOrder,
  type BuiltPrompt,
  type PromptStage,
  type VerificationInput,
  type WorkflowStage,
  type WorkflowTask
} from '@repomind/core';
import { useActive, useStore } from '../lib/store';
import { Badge, Button, Card, Confirm, Empty, Field, RiskBadge, TextArea } from '../components/ui';
import { computeImpact, promptFilename, stagePrompt, taskSelection } from '../lib/prompting';
import { responseToDiff } from '../lib/patches';
import { engine } from '../lib/engine';
import { copyText, downloadText, openUrl, rid, timeAgo } from '../lib/util';

const STAGE_HELP: Record<WorkflowStage, string> = {
  understand: 'DeepSeek restates the task, finds missing requirements and asks questions. No code yet.',
  plan: 'DeepSeek proposes a plan: files, risks, edge cases, tests, acceptance criteria. You approve it before any code.',
  implement: 'DeepSeek implements the approved plan as unified diffs. Paste the answer; RepoMind turns it into a patch for review.',
  review: 'DeepSeek reviews the proposed patch together with RepoMind’s regression findings.',
  verify: 'Run the project’s real build and tests locally (with your approval) in Build & Test.',
  correct: 'Real compiler/test failures go back to DeepSeek with the relevant source. Repeat until verification passes.',
  complete: 'Final report built from recorded evidence only: completed work, failing tests, open risks.'
};

export function Workflow() {
  const s = useStore();
  const a = useActive();
  const task = a.tasks.find((t) => t.id === s.activeTaskId) ?? null;
  return (
    <div className="stack">
      <Card title={`Tasks (${a.tasks.length})`} actions={<Button small icon="plus" onClick={() => s.setScreen('context')}>New task</Button>}>
        {a.tasks.length === 0 ? (
          <p className="muted small">Describe a task in the Context Builder and press “Start workflow task”.</p>
        ) : (
          <div className="list">
            {a.tasks.map((t) => (
              <div key={t.id} className={`list-item clickable ${task?.id === t.id ? 'selected' : ''}`} onClick={() => s.setActiveTaskId(t.id)}>
                <span className="grow truncate">{t.title}</span>
                <Badge>{MODES[t.mode].label}</Badge>
                <Badge tone={t.stage === 'complete' && t.completionReport ? 'ok' : 'accent'}>{t.stage}</Badge>
                <span className="muted small">{timeAgo(t.updatedAt)}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
      {task ? <TaskView key={task.id} task={task} /> : a.tasks.length > 0 && <Card><Empty title="Select a task" /></Card>}
    </div>
  );
}

function TaskView({ task }: { task: WorkflowTask }) {
  const s = useStore();
  const a = useActive();
  const order = stageOrder(task.mode);
  const idx = order.indexOf(task.stage);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const save = (patch: Partial<WorkflowTask>) => s.saveTask({ ...task, ...patch });
  const go = (stage: WorkflowStage) => void save({ stage });

  return (
    <>
      <Card
        title={task.title}
        subtitle={`${MODES[task.mode].label} · created ${timeAgo(task.createdAt)} · ${task.corrections.length} correction cycle(s)`}
        actions={<Button small variant="ghost" icon="trash" onClick={() => setConfirmDelete(true)} title="Delete task" />}
      >
        <div className="stepper">
          {order.map((st, i) => (
            <button key={st} className={`step ${i < idx ? 'done' : ''} ${st === task.stage ? 'current' : ''}`} onClick={() => go(st)}>
              <span className="n">{i + 1}</span>
              {st === 'verify' ? 'Verify' : STAGE_LABELS[st as PromptStage]}
            </button>
          ))}
        </div>
        <p className="muted small">{STAGE_HELP[task.stage]}</p>
        <details>
          <summary className="small">Requirement & acceptance criteria</summary>
          <div className="stack-sm" style={{ marginTop: 6 }}>
            <TextArea rows={3} defaultValue={task.description} onBlur={(e) => e.target.value !== task.description && void save({ description: e.target.value })} />
            <Field label="Acceptance criteria (one per line)">
              <TextArea rows={3} defaultValue={task.acceptanceCriteria.join('\n')} onBlur={(e) => void save({ acceptanceCriteria: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) })} />
            </Field>
          </div>
        </details>
        {task.impact && (
          <div className="row">
            <span className="small">Impact:</span>
            <RiskBadge level={task.impact.risk} />
            <span className="muted small truncate grow">{task.impact.likelyToModify.map((l) => l.path.split('/').pop()).join(', ')}</span>
            <Button small variant="ghost" icon="refresh" title="Recompute impact with the current index" onClick={() => {
              const r = s.retriever!.retrieve(`${task.title}\n${task.description}`);
              void save({ impact: computeImpact(a, task.description, r, task.plan?.files.filter((f) => a.index.files[f])) });
            }} />
          </div>
        )}
        <div className="row spread">
          <Button small variant="ghost" disabled={idx <= 0} onClick={() => go(order[idx - 1]!)}>← Previous stage</Button>
          <Button small disabled={idx >= order.length - 1} onClick={() => go(order[idx + 1]!)}>Next stage →</Button>
        </div>
      </Card>

      {task.stage === 'verify' ? <VerifyPanel task={task} /> : <PromptPanel task={task} stage={task.stage as PromptStage} />}

      {task.patches.length > 0 && (
        <Card title={`Patches (${task.patches.length})`}>
          <div className="list">
            {task.patches.map((p) => (
              <div key={p.id} className="list-item">
                <Badge tone={p.status === 'applied' ? 'ok' : p.status === 'failed' || p.status === 'rejected' ? 'bad' : 'neutral'}>{p.status}</Badge>
                <span className="grow small truncate">{parseUnifiedDiff(p.diff).files.map((f) => f.path.split('/').pop()).join(', ')} · {timeAgo(p.createdAt)}</span>
                {p.regression && <Badge tone={p.regression.summary.high ? 'bad' : 'neutral'}>{p.regression.findingCount} findings</Badge>}
                <Button small onClick={() => { s.setPatchDraft({ diff: p.diff, taskId: task.id, source: p.source }); s.setScreen('patch'); }}>Review</Button>
              </div>
            ))}
          </div>
        </Card>
      )}

      {confirmDelete && (
        <Confirm title="Delete task?" confirmLabel="Delete" danger onCancel={() => setConfirmDelete(false)} onConfirm={async () => { await s.deleteTask(task.id); s.setActiveTaskId(null); }}>
          <p>The task history (prompts, responses, patch records, run records) will be deleted. Files in your repository are not affected.</p>
        </Confirm>
      )}
    </>
  );
}

function PromptPanel({ task, stage }: { task: WorkflowTask; stage: PromptStage }) {
  const s = useStore();
  const a = useActive();
  const ex = task.exchanges[stage];
  const [response, setResponse] = useState(ex?.response ?? '');
  const [prompt, setPrompt] = useState<BuiltPrompt | null>(null);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const save = (patch: Partial<WorkflowTask>) => s.saveTask({ ...task, ...patch });
  const lastPatch = task.patches[task.patches.length - 1];

  const generate = async () => {
    setBusy(true);
    try {
      const { selection } = taskSelection(a, s.retriever!, task, s.settings);
      const base = { stage, mode: task.mode, task: task.description, criteria: task.acceptanceCriteria, selection, impact: task.impact, settings: s.settings, plan: task.plan?.approved ? task.plan.text : undefined, understanding: task.exchanges.understand?.response };
      let p: BuiltPrompt;
      if (stage === 'review') {
        if (!lastPatch) throw new Error('No patch to review yet. Complete the Implement stage first.');
        const regression = analyzeRegression(parseUnifiedDiff(lastPatch.diff), a.index, a.contents, { expectedFiles: task.plan?.files });
        p = stagePrompt(a, { ...base, diff: lastPatch.diff, regression });
      } else if (stage === 'correct') {
        const latest = new Map<string, (typeof task.runs)[number]>();
        for (const r of task.runs) latest.set(r.command, r);
        const failing = [...latest.values()].filter((r) => r.status !== 'passed');
        if (!failing.length) throw new Error('No failing verification run recorded for this task. Run builds/tests in Build & Test first.');
        const root = a.project.engine?.root;
        const verification: VerificationInput[] = failing.map((r) => ({ label: r.label, command: r.command, status: r.status, exitCode: r.exitCode, analysis: analyzeLog(r.excerpt, root) }));
        const diagFiles = [...new Set(verification.flatMap((v) => v.analysis?.diagnostics.map((d) => d.file).filter((f): f is string => Boolean(f)) ?? []))].slice(0, 12);
        let extraFiles: { path: string; content: string; reason: string }[] = [];
        if (a.project.engine && engine.state.status === 'connected' && diagFiles.length) {
          const r = await engine.call('project.readFiles', { projectId: a.project.engine.projectId, paths: diagFiles });
          extraFiles = r.files.filter((f) => f.content !== null).map((f) => ({ path: f.path, content: f.content!, reason: 'Current version on disk; named in the failure output' }));
        } else extraFiles = diagFiles.filter((f) => a.contents.has(f)).map((f) => ({ path: f, content: a.contents.get(f)!, reason: 'Named in the failure output (indexed version — may be stale)' }));
        const applied = [...task.patches].reverse().find((x) => x.status === 'applied');
        p = stagePrompt(a, { ...base, selection: undefined, extraFiles, verification, attempt: task.corrections.length + 1, diff: applied?.diff });
        await save({ corrections: [...task.corrections, { attempt: task.corrections.length + 1, at: new Date().toISOString(), prompt: p.text.slice(0, 2000) }] });
      } else if (stage === 'complete') {
        p = stagePrompt(a, { ...base, selection: undefined, diff: task.patches.filter((x) => x.status === 'applied').map((x) => x.diff).join('\n'), verification: task.runs.slice(-8).map((r) => ({ label: r.label, command: r.command, status: r.status, exitCode: r.exitCode, analysis: analyzeLog(r.excerpt, a.project.engine?.root) })) });
      } else p = stagePrompt(a, base);
      setPrompt(p);
      await s.saveTask({ ...task, exchanges: { ...task.exchanges, [stage]: { ...ex, prompt: p.text, promptTokens: p.tokens, at: new Date().toISOString() } } });
      return p;
    } catch (e) {
      s.toast((e as Error).message, 'error');
      return null;
    } finally {
      setBusy(false);
    }
  };

  const saveResponse = async () => {
    const exchanges = { ...task.exchanges, [stage]: { ...ex, prompt: ex?.prompt ?? prompt?.text, response, at: new Date().toISOString() } };
    const patch: Partial<WorkflowTask> = { exchanges };
    if (stage === 'plan') {
      patch.plan = { text: response, approved: false, files: extractPlanFiles(response, a.index), units: extractUnits(response, a.index) };
      const crit = extractAcceptanceCriteria(response);
      if (crit.length && !task.acceptanceCriteria.length) patch.acceptanceCriteria = crit;
    }
    if (stage === 'implement' || stage === 'correct' || stage === 'review') {
      const r = responseToDiff(response, a);
      if (r.diff) {
        const rec = { id: rid('p'), source: 'deepseek' as const, diff: r.diff, createdAt: new Date().toISOString(), status: 'proposed' as const, note: r.notes.join('\n') };
        patch.patches = [...task.patches, rec];
        s.setPatchDraft({ diff: r.diff, taskId: task.id, source: 'deepseek' });
        s.toast(`Extracted a patch with ${r.files} file(s). Review it before applying.`, 'success');
      } else if (stage !== 'review') s.toast(r.notes.join(' ') || 'No code changes found in the response.', 'error');
    }
    if (stage === 'complete') patch.completionReport = response;
    await save(patch);
    s.log('task', `Saved ${STAGE_LABELS[stage]} response for “${task.title}”`);
  };

  const suggestions = useMemo(() => (ex?.response ? extractSuggestions(ex.response) : []), [ex?.response]);
  const addSuggestions = async () => {
    let mem = a.memory;
    for (const sug of suggestions) mem = addEntry(mem, { ...sug, provenance: 'suggested', source: `deepseek · ${task.title}` });
    await s.saveMemory(mem);
    s.toast(`${suggestions.length} suggestion(s) added to Memory for review. They are not used in prompts until you approve them.`, 'success');
  };

  return (
    <>
      <Card title={`${STAGE_LABELS[stage]} prompt`} subtitle={ex?.promptTokens ? `Last generated ${timeAgo(ex.at)} · ≈${formatTokens(ex.promptTokens)} tokens (estimate)` : 'Not generated yet'}>
        {stage === 'implement' && task.plan && !task.plan.approved && <div className="callout warn">The plan is not approved. The implementation prompt will not include it.</div>}
        <div className="row">
          <Button variant="primary" icon="copy" busy={busy} onClick={async () => { const p = await generate(); if (p) { await copyText(p.text); s.toast('Prompt copied. Paste it into DeepSeek.', 'success'); } }}>Generate & copy</Button>
          <Button icon="external" onClick={() => openUrl(s.settings.deepseekUrl)}>Open DeepSeek</Button>
          {(prompt || ex?.prompt) && <Button variant="ghost" onClick={() => setShow(!show)}>{show ? 'Hide' : 'Preview'}</Button>}
          {(prompt || ex?.prompt) && <Button variant="ghost" icon="download" onClick={() => downloadText(promptFilename(a.project.name, stage), prompt?.text ?? ex!.prompt!)} />}
        </div>
        {show && <pre className="prompt-preview">{prompt?.text ?? ex?.prompt}</pre>}
      </Card>

      <Card title="DeepSeek response" subtitle="Paste DeepSeek’s full answer here. RepoMind never reads the DeepSeek page itself.">
        <TextArea rows={8} value={response} onChange={(e) => setResponse(e.target.value)} placeholder="Paste the response…" />
        <div className="row">
          <Button variant="primary" disabled={!response.trim()} onClick={() => void saveResponse()}>Save response</Button>
          {(stage === 'implement' || stage === 'correct' || stage === 'review') && s.patchDraft?.taskId === task.id && <Button icon="patch" onClick={() => s.setScreen('patch')}>Review patch</Button>}
          {suggestions.length > 0 && <Button variant="ghost" onClick={() => void addSuggestions()}>Add {suggestions.length} memory suggestion(s)</Button>}
        </div>
      </Card>

      {stage === 'plan' && task.plan && (
        <Card title="Extracted plan" actions={task.plan.approved ? <Badge tone="ok">approved</Badge> : <Badge tone="warn">awaiting approval</Badge>}>
          <div className="stack-sm">
            <strong className="small">Files ({task.plan.files.length})</strong>
            <ul className="plain small mono">{task.plan.files.map((f) => <li key={f}>{a.index.files[f] ? f : <span>{f} <Badge tone="info">new</Badge></span>}</li>)}</ul>
            {task.plan.units.length > 0 && (
              <>
                <strong className="small">Implementation units</strong>
                <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>{task.plan.units.map((u, i) => <li key={i}>{u.title}</li>)}</ol>
              </>
            )}
            {task.acceptanceCriteria.length > 0 && (
              <>
                <strong className="small">Acceptance criteria</strong>
                <ul className="bullets small">{task.acceptanceCriteria.map((c) => <li key={c}>{c}</li>)}</ul>
              </>
            )}
          </div>
          {!task.plan.approved && (
            <div className="row">
              <Button variant="primary" icon="check" onClick={() => {
                const r = s.retriever!.retrieve(`${task.title}\n${task.description}`);
                const targets = task.plan!.files.filter((f) => a.index.files[f]);
                void save({ plan: { ...task.plan!, approved: true, approvedAt: new Date().toISOString() }, impact: computeImpact(a, task.description, r, targets), contextPaths: [...new Set([...task.contextPaths, ...targets])], stage: 'implement' });
                s.log('task', `Approved plan for “${task.title}”`);
              }}>Approve plan & continue</Button>
              <span className="muted small">Approving also recomputes the impact report for the planned files.</span>
            </div>
          )}
        </Card>
      )}

      {stage === 'complete' && (
        <Card title="Evidence-based report (generated locally)" actions={<Button small icon="download" onClick={() => downloadText(`report-${task.id}.md`, buildCompletionReport(task))}>Export</Button>}>
          <pre className="prompt-preview">{buildCompletionReport(task)}</pre>
          <div className="row">
            <Button onClick={async () => {
              const mem = addEntry(a.memory, { category: 'completed-task', text: `${task.title} (${new Date().toISOString().slice(0, 10)})`, provenance: 'suggested', source: 'workflow' });
              await s.saveMemory(mem);
              s.toast('Added as a memory suggestion. Approve it in Memory.', 'success');
            }}>Suggest “completed task” memory entry</Button>
          </div>
        </Card>
      )}
    </>
  );
}

function VerifyPanel({ task }: { task: WorkflowTask }) {
  const s = useStore();
  const latest = new Map<string, (typeof task.runs)[number]>();
  for (const r of task.runs) latest.set(r.command, r);
  const results = [...latest.values()];
  const failing = results.filter((r) => r.status !== 'passed');
  const applied = task.patches.some((p) => p.status === 'applied');
  return (
    <Card title="Verification" subtitle="Results are recorded from real command output. Nothing is marked as passed unless the command exited 0.">
      {!applied && <div className="callout warn">No patch from this task has been applied yet.</div>}
      {results.length === 0 ? (
        <p className="muted small">No commands run for this task yet.</p>
      ) : (
        <div className="list">
          {results.map((r) => (
            <div key={r.id} className="list-item">
              <Badge tone={r.status === 'passed' ? 'ok' : r.status === 'failed' ? 'bad' : 'warn'}>{r.status}</Badge>
              <span className="mono small grow truncate">{r.command}</span>
              <span className="muted small">{r.diagnostics} diag · {r.failedTests} failed tests · {timeAgo(r.startedAt)}</span>
            </div>
          ))}
        </div>
      )}
      <div className="row">
        <Button variant="primary" icon="build" onClick={() => { s.setActiveTaskId(task.id); s.setScreen('build'); }}>Open Build & Test</Button>
        {failing.length > 0 && <Button onClick={() => void s.saveTask({ ...task, stage: 'correct' })}>Create correction prompt →</Button>}
        {results.length > 0 && failing.length === 0 && <Button onClick={() => void s.saveTask({ ...task, stage: 'complete' })}>All passed — complete →</Button>}
      </div>
    </Card>
  );
}
