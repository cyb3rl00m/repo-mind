import { useMemo, useState } from 'react';
import { MODES, STAGE_LABELS, TOKEN_ESTIMATE_LABEL, createTask, formatTokens, renderImpactMarkdown, type BuiltPrompt, type EngineeringMode, type PromptStage, type RetrievalResult } from '@repomind/core';
import { useActive, useStore } from '../lib/store';
import { Badge, Button, Card, Empty, Field, Icon, Progress, RiskBadge, TextArea } from '../components/ui';
import { PathLabel } from '../components/PathLabel';
import { computeImpact, computeSelection, packagePrompts, promptFilename, stagePrompt } from '../lib/prompting';
import { copyText, downloadText, openUrl } from '../lib/util';

const BUDGETS = [16000, 32000, 48000, 64000, 100000];

export function ContextBuilder() {
  const s = useStore();
  const a = useActive();
  const d = s.contextDraft;
  const [submitted, setSubmitted] = useState(d.task);
  const [showPrompt, setShowPrompt] = useState(false);
  const [packages, setPackages] = useState<BuiltPrompt[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const retrieval: RetrievalResult | null = useMemo(() => (submitted.trim() && s.retriever ? s.retriever.retrieve(submitted) : null), [submitted, s.retriever]);
  const selection = useMemo(() => (retrieval ? computeSelection(a, retrieval, d.include, d.exclude, s.settings) : null), [retrieval, a, d.include, d.exclude, s.settings]);
  const impact = useMemo(() => (retrieval ? computeImpact(a, submitted, retrieval) : null), [retrieval, a, submitted]);
  const criteria = d.criteria.split('\n').map((x) => x.trim()).filter(Boolean);
  const stages = MODES[d.mode].stages;
  const stage = stages.includes(d.stage) ? d.stage : stages[0]!;
  const prompt = useMemo(
    () => (selection && impact ? stagePrompt(a, { stage, mode: d.mode, task: submitted, criteria, selection, impact, settings: s.settings }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selection, impact, stage, d.mode, submitted, d.criteria, a, s.settings]
  );

  const toggle = (path: string, included: boolean) => {
    if (included) s.setContextDraft({ exclude: [...d.exclude, path], include: d.include.filter((x) => x !== path) });
    else s.setContextDraft({ include: [...d.include, path], exclude: d.exclude.filter((x) => x !== path) });
  };

  const copy = async (text: string, label = 'Prompt') => {
    await copyText(text);
    s.toast(`${label} copied. Paste it into DeepSeek.`, 'success');
    s.log('prompt', `Copied ${label.toLowerCase()} (${formatTokens(prompt?.tokens ?? 0)} tokens est.) for “${submitted.slice(0, 60)}”`);
  };

  const startTask = async () => {
    if (!selection || !impact) return;
    const t = createTask(a.project.id, '', submitted, d.mode);
    t.contextPaths = selection.items.map((i) => i.path);
    t.impact = impact;
    t.acceptanceCriteria = criteria;
    await s.saveTask(t);
    s.setActiveTaskId(t.id);
    s.log('task', `Started ${MODES[d.mode].label} task “${t.title}”`);
    s.setScreen('workflow');
  };

  const used = (selection?.totals.tokens ?? 0) + s.settings.reservedTokens;
  return (
    <div className="stack">
      <Card title="Task">
        <TextArea
          rows={4}
          value={d.task}
          placeholder="Describe the change, bug or question. Name screens, classes, files or paste an error message — specific words give better retrieval."
          onChange={(e) => s.setContextDraft({ task: e.target.value })}
          onKeyDown={(e) => (e.ctrlKey || e.metaKey) && e.key === 'Enter' && setSubmitted(d.task)}
        />
        <div className="grid-2">
          <Field label="Engineering mode" hint={MODES[d.mode].summary}>
            <select className="input" value={d.mode} onChange={(e) => s.setContextDraft({ mode: e.target.value as EngineeringMode, stage: MODES[e.target.value as EngineeringMode].stages[0] })}>
              {Object.values(MODES).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </Field>
          <Field label="Prompt stage">
            <select className="input" value={stage} onChange={(e) => s.setContextDraft({ stage: e.target.value as PromptStage })}>
              {stages.map((st) => <option key={st} value={st}>{STAGE_LABELS[st]}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Acceptance criteria (optional, one per line)">
          <TextArea rows={2} value={d.criteria} onChange={(e) => s.setContextDraft({ criteria: e.target.value })} />
        </Field>
        <div className="row">
          <Button variant="primary" icon="search" disabled={!d.task.trim()} onClick={() => { setSubmitted(d.task); setPackages(null); }}>Find relevant code</Button>
          <span className="muted small">Ctrl+Enter</span>
        </div>
      </Card>

      {!retrieval ? (
        <Card><Empty title="No analysis yet">RepoMind ranks files with BM25 over paths, symbols and code, then follows imports, dependents, tests and configuration from the dependency graph.</Empty></Card>
      ) : (
        <>
          <Card
            title="Context budget"
            subtitle={`Token counts are ${TOKEN_ESTIMATE_LABEL}. DeepSeek’s available context varies by session — keep a margin.`}
            actions={
              <select className="input" style={{ width: 120 }} value={s.settings.budgetTokens} onChange={(e) => void s.updateSettings({ budgetTokens: Number(e.target.value) })} aria-label="Budget">
                {[...new Set([...BUDGETS, s.settings.budgetTokens])].sort((x, y) => x - y).map((b) => <option key={b} value={b}>{formatTokens(b)} tokens</option>)}
              </select>
            }
          >
            <Progress value={used} max={s.settings.budgetTokens} />
            <div className="stats">
              <div className="stat"><div className="stat-value">≈{formatTokens(prompt?.tokens ?? used)}</div><div className="stat-label">prompt tokens</div></div>
              <div className="stat"><div className="stat-value">{((prompt?.chars ?? selection!.totals.chars) / 1000).toFixed(0)}k</div><div className="stat-label">characters</div></div>
              <div className="stat"><div className="stat-value">{selection!.totals.files}</div><div className="stat-label">files included{selection!.totals.outlines ? ` (${selection!.totals.outlines} outlines)` : ''}</div></div>
              <div className="stat"><div className="stat-value">{selection!.overflow.length + selection!.excluded.length}</div><div className="stat-label">excluded / overflow</div></div>
              <div className="stat"><div className="stat-value">{selection!.totals.dependencyCount}</div><div className="stat-label">dependencies inside</div></div>
            </div>
            {[...retrieval.warnings, ...selection!.warnings].map((w) => <div key={w} className="callout warn">{w}</div>)}
            {selection!.overflow.some((o) => o.required) && (
              <div className="row">
                <Button icon="copy" onClick={() => setPackages(packagePrompts(a, { stage, mode: d.mode, task: submitted, criteria, impact: impact!, settings: s.settings }, selection!))}>Split into multiple packages</Button>
              </div>
            )}
          </Card>

          <Card title={`Selected files (${selection!.items.length})`} subtitle="Uncheck to exclude; check overflow files to force-include.">
            <div className="list">
              {selection!.items.map((it) => (
                <div key={it.path}>
                  <div className="list-item">
                    <input type="checkbox" checked onChange={() => toggle(it.path, true)} aria-label={`Exclude ${it.path}`} />
                    <div className="grow" style={{ minWidth: 0 }} onClick={() => setExpanded(expanded === it.path ? null : it.path)}>
                      <div className="row nowrap">
                        <PathLabel path={it.path} />
                        {it.required && <Badge tone="accent" title={it.requiredBecause}>required</Badge>}
                        {it.mode === 'outline' && <Badge tone="warn">outline</Badge>}
                        {it.redactions > 0 && <Badge tone="bad">{it.redactions} redacted</Badge>}
                        {it.injectionWarnings > 0 && <Badge tone="warn">untrusted text</Badge>}
                      </div>
                      {expanded === it.path ? (
                        <ul className="reasons">
                          {it.reasons.map((r) => <li key={r}>{r}</li>)}
                          {it.dependencies.length > 0 && <li>Depends on: {it.dependencies.slice(0, 8).join(', ')}</li>}
                        </ul>
                      ) : (
                        <div className="muted small truncate">{it.reasons[0]}</div>
                      )}
                    </div>
                    <span className="score" title="Relevance">{Math.round(it.score * 100)}%</span>
                    <span className="score" title="Estimated tokens">≈{formatTokens(it.tokens)}</span>
                  </div>
                </div>
              ))}
              {selection!.overflow.map((o) => (
                <div key={o.path} className="list-item excluded">
                  <input type="checkbox" checked={false} onChange={() => toggle(o.path, false)} aria-label={`Include ${o.path}`} />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="row nowrap"><PathLabel path={o.path} />{o.required && <Badge tone="bad">required — not included</Badge>}</div>
                    <div className="muted small">{o.why}</div>
                  </div>
                  <span className="score">≈{formatTokens(o.tokens)}</span>
                </div>
              ))}
              {selection!.excluded.map((p) => (
                <div key={p} className="list-item excluded">
                  <input type="checkbox" checked={false} onChange={() => toggle(p, false)} aria-label={`Include ${p}`} />
                  <PathLabel path={p} />
                  <span className="muted small">excluded</span>
                </div>
              ))}
            </div>
          </Card>

          {impact && (
            <Card title={<span className="row nowrap">Change impact <RiskBadge level={impact.risk} /></span>} subtitle={`Heuristic score ${impact.riskScore}: ${impact.factors.map((f) => `+${f.points} ${f.reason}`).join('; ') || 'no risk factors'}`}>
              <details>
                <summary className="small">Full report ({impact.importers.length} importers, {impact.dependentSymbols.length} shared symbols, {impact.tests.length} tests)</summary>
                <pre className="prompt-preview">{renderImpactMarkdown(impact)}</pre>
              </details>
            </Card>
          )}

          <Card
            title={`Prompt — ${MODES[d.mode].label} · ${STAGE_LABELS[stage]}`}
            subtitle={prompt ? `≈${formatTokens(prompt.tokens)} tokens (estimate) · ${prompt.sections.length} sections${prompt.missing.length ? ` · unavailable: ${prompt.missing.join(', ')}` : ''}` : ''}
            actions={<Button small variant="ghost" onClick={() => setShowPrompt(!showPrompt)}>{showPrompt ? 'Hide' : 'Preview'}</Button>}
          >
            {showPrompt && prompt && <pre className="prompt-preview">{prompt.text}</pre>}
            {prompt && prompt.tokens > s.settings.budgetTokens && <div className="callout bad">The prompt is larger than your budget. Exclude files or split into packages.</div>}
            <div className="row">
              <Button variant="primary" icon="copy" disabled={!prompt} onClick={() => prompt && void copy(prompt.text)}>Copy to DeepSeek</Button>
              <Button icon="external" onClick={() => openUrl(s.settings.deepseekUrl)}>Open DeepSeek</Button>
              <Button icon="download" disabled={!prompt} onClick={() => prompt && downloadText(promptFilename(a.project.name, stage), prompt.text)}>Export .md</Button>
              <Button icon="workflow" onClick={() => void startTask()}>Start workflow task</Button>
            </div>
          </Card>

          {packages && (
            <Card title={`${packages.length} context packages`} subtitle="Send them in order in the same DeepSeek conversation. Each repeats the rules and task.">
              <div className="list">
                {packages.map((p, i) => (
                  <div key={i} className="list-item">
                    <Icon name="context" />
                    <span className="grow">Package {i + 1} / {packages.length}</span>
                    <span className="score">≈{formatTokens(p.tokens)}</span>
                    <Button small icon="copy" onClick={() => void copy(p.text, `Package ${i + 1}`)}>Copy</Button>
                    <Button small variant="ghost" icon="download" onClick={() => downloadText(promptFilename(a.project.name, stage, i + 1), p.text)} />
                  </div>
                ))}
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
