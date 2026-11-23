import {
  analyzeImpact,
  buildPrompt,
  estimateTokens,
  selectContext,
  splitIntoPackages,
  type BuiltPrompt,
  type ContextSelection,
  type EngineeringMode,
  type ImpactReport,
  type PromptInput,
  type PromptStage,
  type RetrievalResult,
  type Retriever,
  type WorkflowTask
} from '@repomind/core';
import type { ActiveData } from './store';
import { identityOf, type Settings } from './types';

export function computeSelection(active: ActiveData, retrieval: RetrievalResult, include: string[], exclude: string[], settings: Settings): ContextSelection {
  return selectContext(retrieval.ranked, active.index, active.contents, {
    budgetTokens: settings.budgetTokens,
    reservedTokens: settings.reservedTokens,
    manualInclude: [...new Set([...active.project.pinnedInclude, ...include])].filter((p) => !exclude.includes(p)),
    manualExclude: [...new Set([...active.project.pinnedExclude, ...exclude])]
  });
}

export function computeImpact(active: ActiveData, task: string, retrieval: RetrievalResult, targets?: string[]): ImpactReport {
  return analyzeImpact(task, retrieval, active.index, active.contents, targets?.length ? { targetFiles: targets } : {});
}

/** Selection for a stored task: the task's context paths are pinned; retrieval fills the rest. */
export function taskSelection(active: ActiveData, retriever: Retriever, task: WorkflowTask, settings: Settings): { retrieval: RetrievalResult; selection: ContextSelection } {
  const retrieval = retriever.retrieve(`${task.title}\n${task.description}`);
  const planFiles = task.plan?.files.filter((f) => active.index.files[f]) ?? [];
  const selection = computeSelection(active, retrieval, [...task.contextPaths, ...planFiles], [], settings);
  return { retrieval, selection };
}

export function stagePrompt(
  active: ActiveData,
  args: {
    stage: PromptStage;
    mode: EngineeringMode;
    task: string;
    criteria?: string[];
    selection?: ContextSelection;
    impact?: ImpactReport;
    settings: Settings;
  } & Partial<Pick<PromptInput, 'plan' | 'understanding' | 'diff' | 'regression' | 'verification' | 'attempt' | 'extraFiles' | 'packageInfo' | 'extraInstructions'>>
): BuiltPrompt {
  return buildPrompt({
    stage: args.stage,
    mode: args.mode,
    identity: identityOf(active.project),
    index: active.index,
    contents: active.contents,
    task: args.task,
    acceptanceCriteria: args.criteria,
    selection: args.selection,
    memory: active.memory,
    impact: args.impact,
    plan: args.plan,
    understanding: args.understanding,
    diff: args.diff,
    regression: args.regression,
    verification: args.verification,
    attempt: args.attempt,
    extraFiles: args.extraFiles,
    packageInfo: args.packageInfo,
    extraInstructions: args.extraInstructions
  });
}

/** Splits a selection into several packages (each fits the budget) and builds one prompt per package. */
export function packagePrompts(active: ActiveData, base: Parameters<typeof stagePrompt>[1], selection: ContextSelection): BuiltPrompt[] {
  const paths = [...selection.items.map((i) => i.path), ...selection.overflow.map((o) => o.path)];
  const header = stagePrompt(active, { ...base, selection: undefined }).tokens;
  const groups = splitIntoPackages(paths, active.contents, base.settings.budgetTokens, header + 500);
  return groups.map((g, i) => {
    const items = g.map((p) => {
      const rec = active.index.files[p]!;
      const existing = selection.items.find((x) => x.path === p);
      return existing ? { ...existing, mode: 'full' as const } : { path: p, mode: 'full' as const, tokens: rec.tokensEstimate, chars: 0, score: 0, reasons: ['Relevant to the task (moved here from overflow)'], required: false, dependencies: [], redactions: 0, injectionWarnings: 0 };
    });
    const sel: ContextSelection = { ...selection, items, overflow: [] };
    return stagePrompt(active, { ...base, selection: sel, packageInfo: { index: i + 1, total: groups.length } });
  });
}

export function promptFilename(projectName: string, stage: string, n?: number): string {
  return `repomind-${projectName.replace(/\W+/g, '-').toLowerCase()}-${stage}${n ? `-part${n}` : ''}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.md`;
}

export { estimateTokens };
