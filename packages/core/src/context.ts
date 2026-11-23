import { neutralizeDelimiters } from './injection.js';
import type { RankedFile } from './retrieval.js';
import { redactSecrets } from './secrets.js';
import { estimateTokens } from './tokens.js';
import type { FileRecord, RepoIndex } from './types.js';

export type InclusionMode = 'full' | 'outline';

export interface ContextItem {
  path: string;
  mode: InclusionMode;
  tokens: number;
  chars: number;
  score: number;
  reasons: string[];
  /** Why the item must not be dropped (seed, manual, dependency of a seed). */
  required: boolean;
  requiredBecause?: string;
  dependencies: string[];
  redactions: number;
  injectionWarnings: number;
}

export interface OverflowItem {
  path: string;
  tokens: number;
  required: boolean;
  why: string;
}

export interface ContextSelection {
  budgetTokens: number;
  items: ContextItem[];
  /** Files that matched but did not fit. Required overflow is never silent: the UI shows it and offers splitting. */
  overflow: OverflowItem[];
  excluded: string[];
  totals: { tokens: number; chars: number; files: number; outlines: number; dependencyCount: number };
  warnings: string[];
}

export interface SelectionOptions {
  budgetTokens: number;
  manualInclude?: string[];
  manualExclude?: string[];
  /** Minimum relative score for optional files. */
  minScore?: number;
  /** Tokens reserved for instructions, task, memory and impact report. */
  reservedTokens?: number;
}

/** Renders a compact outline of a file: imports + declaration signatures with line numbers. */
export function renderOutline(rec: FileRecord): string {
  const lines: string[] = [];
  if (rec.pkg) lines.push(`package ${rec.pkg}`);
  const internal = rec.imports.filter((i) => i.target).map((i) => i.spec);
  if (internal.length) lines.push(`// internal imports: ${internal.slice(0, 20).join(', ')}`);
  for (const s of rec.symbols) {
    const indent = s.container ? '    ' : '';
    lines.push(`${indent}L${s.line}: ${s.signature}`);
  }
  if (rec.symbols.length === 0) lines.push('// (no declarations extracted)');
  return lines.join('\n');
}

/** Prepares file content for export: secrets redacted, RepoMind delimiters neutralized. */
export function sanitizeForPrompt(content: string): { text: string; redactions: number } {
  const { text, count } = redactSecrets(content);
  return { text: neutralizeDelimiters(text), redactions: count };
}

/**
 * Chooses which files enter the context package under a token budget.
 *
 * Rules:
 *  - Manual includes and task seeds are required.
 *  - Direct dependencies of the top seeds are required (at least as an outline).
 *  - Optional files are added greedily by score.
 *  - Nothing required is ever dropped silently: it is downgraded to an outline, and if even the
 *    outline does not fit it is reported in `overflow` with `required: true`.
 */
export function selectContext(
  ranked: RankedFile[],
  index: RepoIndex,
  contents: Map<string, string>,
  opts: SelectionOptions
): ContextSelection {
  const exclude = new Set(opts.manualExclude ?? []);
  const include = new Set(opts.manualInclude ?? []);
  const minScore = opts.minScore ?? 0.15;
  const budget = Math.max(0, opts.budgetTokens - (opts.reservedTokens ?? 0));
  const warnings: string[] = [];
  const items: ContextItem[] = [];
  const overflow: OverflowItem[] = [];
  let used = 0;

  const byPath = new Map(ranked.map((r) => [r.path, r]));
  for (const p of include) {
    if (!byPath.has(p) && index.files[p]) {
      const rec = index.files[p]!;
      byPath.set(p, { path: p, score: 1, reasons: [{ kind: 'manual', text: 'Manually included', weight: 1 }], matchedTerms: [], dependencies: [], dependents: [], tokens: rec.tokensEstimate, role: rec.role, seed: true });
    }
  }

  const required = new Map<string, string>();
  for (const p of include) required.set(p, 'manually included');
  const seeds = ranked.filter((r) => r.seed && r.score >= 0.35 && !exclude.has(r.path)).slice(0, 6);
  for (const s of seeds) required.set(s.path, 'directly matches the task');
  for (const s of seeds.slice(0, 4)) {
    for (const d of s.dependencies) if (!exclude.has(d) && !required.has(d) && index.files[d]) required.set(d, `direct dependency of ${s.path}`);
  }

  const measure = (path: string, mode: InclusionMode) => {
    const rec = index.files[path]!;
    const raw = mode === 'full' ? contents.get(path) ?? '' : renderOutline(rec);
    const { text, redactions } = sanitizeForPrompt(raw);
    return { tokens: estimateTokens(text) + 12, chars: text.length, redactions };
  };

  const add = (path: string, mode: InclusionMode, why?: string) => {
    const r = byPath.get(path);
    const m = measure(path, mode);
    if (used + m.tokens > budget) return false;
    used += m.tokens;
    items.push({
      path,
      mode,
      tokens: m.tokens,
      chars: m.chars,
      score: r?.score ?? 0,
      reasons: r?.reasons.map((x) => x.text) ?? (why ? [`Required: ${why}`] : []),
      required: Boolean(why),
      requiredBecause: why,
      dependencies: r?.dependencies ?? index.edges.filter((e) => e.from === path).map((e) => e.to),
      redactions: m.redactions,
      injectionWarnings: index.files[path]?.injectionFindings.length ?? 0
    });
    return true;
  };

  // Required first, in priority order (manual, seeds by score, then dependencies).
  const requiredOrder = [...required.entries()].sort((a, b) => (byPath.get(b[0])?.score ?? 0) - (byPath.get(a[0])?.score ?? 0));
  for (const [path, why] of requiredOrder) {
    if (add(path, 'full', why)) continue;
    if (add(path, 'outline', why)) {
      warnings.push(`${path} is required (${why}) but too large for the remaining budget; included as an outline (signatures only).`);
      continue;
    }
    overflow.push({ path, tokens: index.files[path]!.tokensEstimate, required: true, why: `Required (${why}) but does not fit even as an outline` });
  }
  for (const r of ranked) {
    if (required.has(r.path) || exclude.has(r.path)) continue;
    if (r.score < minScore) continue;
    if (!add(r.path, 'full')) {
      if (r.score >= 0.3 && add(r.path, 'outline')) continue;
      overflow.push({ path: r.path, tokens: r.tokens, required: false, why: `Relevance ${(r.score * 100).toFixed(0)}% — did not fit the budget` });
    }
  }
  if (overflow.some((o) => o.required)) warnings.push('Some required files did not fit. Increase the budget or split the context into multiple packages.');
  const injections = items.filter((i) => i.injectionWarnings > 0);
  if (injections.length) warnings.push(`${injections.length} included files contain instruction-like text (possible prompt injection). They are wrapped as untrusted data.`);
  const redactions = items.reduce((a, i) => a + i.redactions, 0);
  if (redactions) warnings.push(`${redactions} secret-looking values were redacted from the context.`);

  const depSet = new Set(items.flatMap((i) => i.dependencies));
  return {
    budgetTokens: opts.budgetTokens,
    items,
    overflow,
    excluded: [...exclude],
    totals: {
      tokens: used,
      chars: items.reduce((a, i) => a + i.chars, 0),
      files: items.length,
      outlines: items.filter((i) => i.mode === 'outline').length,
      dependencyCount: [...depSet].filter((d) => items.some((i) => i.path === d)).length
    },
    warnings
  };
}

/**
 * Splits a ranked file list into several packages that each fit the budget. Every package carries
 * the same header (task, memory, rules); files are distributed in score order, keeping each seed
 * together with as many of its dependencies as fit.
 */
export function splitIntoPackages(
  paths: string[],
  contents: Map<string, string>,
  budgetTokens: number,
  reservedTokens: number
): string[][] {
  const per = Math.max(1000, budgetTokens - reservedTokens);
  const packages: string[][] = [];
  let current: string[] = [];
  let used = 0;
  for (const p of paths) {
    const t = estimateTokens(sanitizeForPrompt(contents.get(p) ?? '').text) + 12;
    if (used + t > per && current.length) {
      packages.push(current);
      current = [];
      used = 0;
    }
    current.push(p);
    used += t;
  }
  if (current.length) packages.push(current);
  return packages;
}
