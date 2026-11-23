import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Retriever, analyzeImpact, buildPrompt, selectContext, tokenize, type RepoIndex } from '../packages/core/src/index.js';
import { indexed } from '../packages/core/test/helpers.js';

export interface BenchTask {
  id: string;
  category: string;
  fixture: string;
  task: string;
  mustInclude: string[];
}

export interface BenchRow {
  id: string;
  category: string;
  recallAt5: number;
  recallAt10: number;
  baselineRecallAt10: number;
  contextRecall: number;
  impactRecall: number;
  contextFiles: number;
  contextTokens: number;
  promptTokens: number;
  risk: string;
  missing: string[];
}

export function loadTasks(): BenchTask[] {
  return (JSON.parse(readFileSync(fileURLToPath(new URL('./tasks.json', import.meta.url)), 'utf8')) as { tasks: BenchTask[] }).tasks;
}

const recall = (found: string[], must: string[]) => must.filter((m) => found.includes(m)).length / must.length;

/** Naive baseline: what pasting "files that contain the task's words" gives you (raw keyword counts, no graph). */
export function keywordBaseline(task: string, index: RepoIndex, contents: Map<string, string>): string[] {
  const words = [...new Set(tokenize(task))];
  return Object.keys(index.files)
    .map((p) => {
      const text = (contents.get(p) ?? '').toLowerCase() + ' ' + p.toLowerCase();
      return { p, n: words.reduce((a, w) => a + (text.split(w).length - 1), 0) };
    })
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n)
    .map((x) => x.p);
}

export function runBench(budgetTokens = 12000): BenchRow[] {
  return loadTasks().map((t) => {
    const { index, contents } = indexed(t.fixture);
    const r = new Retriever(index, contents).retrieve(t.task);
    const ranked = r.ranked.map((x) => x.path);
    const sel = selectContext(r.ranked, index, contents, { budgetTokens, reservedTokens: 2000 });
    const impact = analyzeImpact(t.task, r, index, contents);
    const impactFiles = new Set([
      ...impact.likelyToModify.map((x) => x.path),
      ...impact.importers.map((x) => x.path),
      ...impact.tests.map((x) => x.path),
      ...impact.configuration.map((x) => x.path),
      ...impact.database.map((x) => x.path),
      ...impact.dependentSymbols.flatMap((d) => [d.definedIn, ...d.usedIn])
    ]);
    const prompt = buildPrompt({ stage: 'plan', mode: 'implementation', identity: { name: t.fixture, source: 'local-engine' }, index, contents, task: t.task, selection: sel, impact });
    const included = sel.items.map((i) => i.path);
    return {
      id: t.id,
      category: t.category,
      recallAt5: recall(ranked.slice(0, 5), t.mustInclude),
      recallAt10: recall(ranked.slice(0, 10), t.mustInclude),
      baselineRecallAt10: recall(keywordBaseline(t.task, index, contents).slice(0, 10), t.mustInclude),
      contextRecall: recall(included, t.mustInclude),
      impactRecall: recall([...impactFiles], t.mustInclude),
      contextFiles: included.length,
      contextTokens: sel.totals.tokens,
      promptTokens: prompt.tokens,
      risk: impact.risk,
      missing: t.mustInclude.filter((m) => !included.includes(m))
    };
  });
}
