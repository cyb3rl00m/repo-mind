import type { ImpactReport } from './impact.js';
import { newId } from './memory.js';
import type { EngineeringMode, PromptStage } from './prompts/modes.js';
import { MODES } from './prompts/modes.js';
import type { RegressionReport } from './regression.js';
import type { RepoIndex } from './types.js';

export type WorkflowStage = 'understand' | 'plan' | 'implement' | 'review' | 'verify' | 'correct' | 'complete';

export type RunStatus = 'passed' | 'failed' | 'skipped' | 'not-executed' | 'inconclusive';

export interface StageExchange {
  prompt?: string;
  promptTokens?: number;
  response?: string;
  at?: string;
}

export interface PatchRecord {
  id: string;
  source: 'deepseek' | 'manual';
  diff: string;
  createdAt: string;
  status: 'proposed' | 'validated' | 'applied' | 'rejected' | 'reverted' | 'failed';
  regression?: Pick<RegressionReport, 'summary' | 'checklist'> & { findingCount: number };
  appliedAt?: string;
  checkpoint?: string;
  note?: string;
}

export interface RunRecord {
  id: string;
  label: string;
  command: string;
  cwd: string;
  status: RunStatus;
  exitCode: number | null;
  durationMs: number;
  startedAt: string;
  excerpt: string;
  diagnostics: number;
  failedTests: number;
  truncated: boolean;
}

export interface WorkflowTask {
  id: string;
  projectId: string;
  title: string;
  description: string;
  mode: EngineeringMode;
  stage: WorkflowStage;
  createdAt: string;
  updatedAt: string;
  acceptanceCriteria: string[];
  contextPaths: string[];
  exchanges: Partial<Record<PromptStage, StageExchange>>;
  plan?: { text: string; approved: boolean; approvedAt?: string; files: string[]; units: { title: string; files: string[]; done: boolean }[] };
  impact?: ImpactReport;
  patches: PatchRecord[];
  runs: RunRecord[];
  corrections: { attempt: number; at: string; prompt: string }[];
  completionReport?: string;
}

export function createTask(projectId: string, title: string, description: string, mode: EngineeringMode): WorkflowTask {
  const now = new Date().toISOString();
  const first = MODES[mode].stages[0]!;
  return {
    id: newId('t'),
    projectId,
    title: title.trim() || description.trim().split('\n')[0]!.slice(0, 80) || 'Untitled task',
    description,
    mode,
    stage: first === 'handoff' ? 'complete' : (first as WorkflowStage),
    createdAt: now,
    updatedAt: now,
    acceptanceCriteria: [],
    contextPaths: [],
    exchanges: {},
    patches: [],
    runs: [],
    corrections: []
  };
}

/** Extracts repository paths mentioned in a plan. Paths not in the index are kept only if marked NEW. */
export function extractPlanFiles(plan: string, index: RepoIndex): string[] {
  const found = new Set<string>();
  for (const m of plan.matchAll(/`?([\w@.-]+(?:\/[\w@.-]+)+\.[A-Za-z0-9]+)`?(\s*[-—:(]*\s*\**NEW FILE\**)?/g)) {
    const p = m[1]!.replace(/^\.\//, '');
    if (index.files[p] || m[2]) found.add(p);
  }
  return [...found];
}

/** Acceptance criteria from a plan: checklist items or a numbered list under an “Acceptance criteria” heading. */
export function extractAcceptanceCriteria(text: string): string[] {
  const out: string[] = [];
  let inSection = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (/^#{1,4}\s|^\*\*.+\*\*:?$/.test(line)) {
      inSection = /acceptance criteria/i.test(line);
      continue;
    }
    const check = /^[-*]\s*\[[ xX]\]\s+(.+)$/.exec(line);
    if (check) {
      if (inSection) out.push(check[1]!.trim());
      continue;
    }
    if (inSection) {
      const item = /^(?:[-*•]|\d+[.)])\s+(.+)$/.exec(line);
      if (item) out.push(item[1]!.trim());
    }
  }
  return [...new Set(out)];
}

/** Implementation units: numbered items under an “Implementation units” heading. */
export function extractUnits(plan: string, index: RepoIndex): { title: string; files: string[]; done: boolean }[] {
  const units: { title: string; files: string[]; done: boolean }[] = [];
  let inSection = false;
  for (const raw of plan.split('\n')) {
    const line = raw.trim();
    if (/^#{1,4}\s|^\*\*.+\*\*:?$/.test(line)) {
      inSection = /implementation units|implementation steps|steps/i.test(line);
      continue;
    }
    if (!inSection) continue;
    const item = /^(?:\d+[.)]|[-*•])\s+(.+)$/.exec(line);
    if (item) units.push({ title: item[1]!.replace(/\*\*/g, ''), files: extractPlanFiles(item[1]!, index), done: false });
    else if (units.length && /^[-*•]\s+/.test(raw) && raw.startsWith('  ')) units[units.length - 1]!.files.push(...extractPlanFiles(line, index));
  }
  return units;
}

export function stageOrder(mode: EngineeringMode): WorkflowStage[] {
  const stages = MODES[mode].stages.filter((s): s is Exclude<PromptStage, 'handoff'> => s !== 'handoff') as WorkflowStage[];
  const out: WorkflowStage[] = [];
  for (const s of stages) {
    out.push(s);
    if (s === 'implement' && !stages.includes('review')) out.push('verify');
    if (s === 'review') out.push('verify');
  }
  if (!out.includes('complete')) out.push('complete');
  return out;
}

/** Final development report assembled from recorded evidence only. */
export function buildCompletionReport(task: WorkflowTask): string {
  const out: string[] = [];
  out.push(`# Development report — ${task.title}`, '');
  out.push(`- Mode: ${MODES[task.mode].label}`, `- Created: ${task.createdAt}`, `- Last update: ${task.updatedAt}`, '');
  out.push('## Requirement', '', task.description || '_none_', '');
  if (task.acceptanceCriteria.length) {
    out.push('## Acceptance criteria', '', ...task.acceptanceCriteria.map((c) => `- [ ] ${c} _(verify manually — RepoMind does not mark criteria as met automatically)_`), '');
  }
  out.push('## Plan', '', task.plan ? `${task.plan.approved ? 'Approved' : 'NOT approved'}${task.plan.approvedAt ? ` on ${task.plan.approvedAt}` : ''}. Files: ${task.plan.files.join(', ') || 'none extracted'}` : '_No plan recorded._', '');
  if (task.plan?.units.length) out.push(...task.plan.units.map((u) => `- [${u.done ? 'x' : ' '}] ${u.title}`), '');
  out.push('## Patches', '');
  if (!task.patches.length) out.push('_No patches recorded._');
  for (const p of task.patches) {
    out.push(`- ${p.createdAt} — ${p.status}${p.regression ? ` — ${p.regression.findingCount} findings (${p.regression.summary.high} high), verdict: ${p.regression.summary.verdict}` : ''}${p.checkpoint ? ` — checkpoint ${p.checkpoint.slice(0, 10)}` : ''}`);
  }
  out.push('', '## Verification (actual results)', '');
  if (!task.runs.length) out.push('_No verification commands were executed. Nothing is verified._');
  for (const r of task.runs) out.push(`- ${r.startedAt} \`${r.command}\` → **${r.status.toUpperCase()}** (exit ${r.exitCode ?? 'n/a'}, ${(r.durationMs / 1000).toFixed(1)} s, ${r.diagnostics} diagnostics, ${r.failedTests} failed tests)`);
  out.push('', `## Correction cycles: ${task.corrections.length}`, '');
  const lastByCommand = new Map<string, RunRecord>();
  for (const r of task.runs) lastByCommand.set(r.command, r);
  const failing = [...lastByCommand.values()].filter((r) => r.status !== 'passed');
  out.push('## Outstanding', '');
  if (failing.length) out.push(...failing.map((r) => `- \`${r.command}\` latest status: ${r.status}`));
  if (!task.runs.length) out.push('- No verification performed.');
  if (task.patches.some((p) => p.status === 'proposed' || p.status === 'validated')) out.push('- Some patches were never applied.');
  if (task.plan && !task.plan.approved) out.push('- Plan was never approved.');
  if (failing.length === 0 && task.runs.length && !task.patches.some((p) => p.status === 'proposed')) out.push('- None recorded. (All executed commands passed on their latest run.)');
  return out.join('\n');
}
