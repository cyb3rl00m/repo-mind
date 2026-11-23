import { RepoGraph } from './graph.js';
import { basename } from './lang.js';
import { Bm25Index, expandQuery, tokenize, type QueryTerm } from './search.js';
import type { FileRecord, RepoIndex } from './types.js';

export type SelectionReasonKind = 'lexical' | 'symbol' | 'path' | 'dependency' | 'dependent' | 'test' | 'config' | 'docs' | 'resource' | 'manual' | 'entry';

export interface SelectionReason {
  kind: SelectionReasonKind;
  text: string;
  weight: number;
}

export interface RankedFile {
  path: string;
  /** 0..1, relative to the best match. */
  score: number;
  reasons: SelectionReason[];
  matchedTerms: string[];
  /** Direct internal dependencies of this file (imports). */
  dependencies: string[];
  /** Files importing this file. */
  dependents: string[];
  tokens: number;
  role: FileRecord['role'];
  /** True for files that matched the task directly (not only through the graph). */
  seed: boolean;
}

export interface RetrievalOptions {
  /** Max lexical seeds used for graph expansion. */
  seeds?: number;
  /** Max results returned. */
  limit?: number;
}

export interface RetrievalResult {
  query: QueryTerm[];
  mentionedSymbols: string[];
  mentionedPaths: string[];
  ranked: RankedFile[];
  warnings: string[];
}

/**
 * Task -> ranked files. Reusable: construct once per index, query many times.
 */
export class Retriever {
  readonly graph: RepoGraph;
  private readonly bm25: Bm25Index;
  private readonly basenames = new Map<string, string[]>();

  constructor(
    readonly index: RepoIndex,
    readonly contents: Map<string, string>
  ) {
    this.graph = new RepoGraph(index);
    const docs = Object.values(index.files).map((f) => ({
      id: f.path,
      path: f.path,
      symbols: f.symbols.map((s) => `${s.name} ${s.container ?? ''}`).join(' '),
      body: (contents.get(f.path) ?? '').slice(0, 200_000)
    }));
    this.bm25 = new Bm25Index(docs);
    for (const p of Object.keys(index.files)) {
      const b = basename(p).toLowerCase();
      this.basenames.set(b, [...(this.basenames.get(b) ?? []), p]);
      const stem = b.replace(/\.[^.]+$/, '');
      if (stem !== b) this.basenames.set(stem, [...(this.basenames.get(stem) ?? []), p]);
    }
  }

  retrieve(task: string, opts: RetrievalOptions = {}): RetrievalResult {
    const seedsN = opts.seeds ?? 10;
    const limit = opts.limit ?? 60;
    const query = expandQuery(task);
    const warnings: string[] = [];
    const acc = new Map<string, { score: number; reasons: SelectionReason[]; matched: Set<string>; seed: boolean }>();
    const bump = (path: string, weight: number, reason: SelectionReason, seed = false, matched: string[] = []) => {
      if (!this.index.files[path]) return;
      const cur = acc.get(path) ?? { score: 0, reasons: [], matched: new Set<string>(), seed: false };
      // Strongest signal dominates; additional signals add a damped bonus.
      cur.score = cur.score === 0 ? weight : Math.max(cur.score, weight) + 0.15 * Math.min(cur.score, weight);
      if (!cur.reasons.some((r) => r.text === reason.text)) cur.reasons.push(reason);
      matched.forEach((m) => cur.matched.add(m));
      cur.seed ||= seed;
      acc.set(path, cur);
    };

    // 1. Explicit mentions of identifiers and file names.
    const mentionedSymbols: string[] = [];
    const mentionedPaths: string[] = [];
    for (const m of task.matchAll(/[A-Za-z_][\w.]*[\w]/g)) {
      const word = m[0];
      for (const simple of new Set([...word.split('.'), word])) {
        const locations = this.index.symbolIndex[simple];
        if (!locations || simple.length <= 2 || !/[A-Z_]|[a-z][A-Z]/.test(simple)) continue;
        mentionedSymbols.push(simple);
        for (const loc of locations.slice(0, 6)) {
          bump(loc.path, 1.6, { kind: 'symbol', text: `Defines \`${simple}\` (${loc.kind}, line ${loc.line}) which the task mentions`, weight: 1.6 }, true, [simple]);
        }
      }
      const byName = this.basenames.get(word.toLowerCase());
      if (byName && byName.length <= 4 && (word.includes('.') || /[A-Z]/.test(word))) {
        mentionedPaths.push(word);
        for (const p of byName) bump(p, 1.8, { kind: 'path', text: `File name \`${basename(p)}\` is mentioned in the task`, weight: 1.8 }, true);
      }
    }
    for (const m of task.matchAll(/[\w./-]+\/[\w.-]+/g)) {
      if (this.index.files[m[0]]) {
        mentionedPaths.push(m[0]);
        bump(m[0], 2, { kind: 'path', text: 'Path is mentioned in the task', weight: 2 }, true);
      }
    }

    // 2. Lexical BM25F.
    const hits = this.bm25.search(query, 150);
    const top = hits[0]?.score ?? 0;
    if (hits.length === 0 && acc.size === 0) warnings.push('No lexical matches. Try naming screens, classes, files or error messages in the task description.');
    for (const h of hits) {
      const rel = top > 0 ? h.score / top : 0;
      if (rel < 0.12) break;
      const original = h.matched.filter((t) => query.find((q) => q.term === t)?.original);
      const synonyms = h.matched.filter((t) => !original.includes(t));
      const why = [original.length ? `matches ${original.slice(0, 6).map((t) => `“${t}”`).join(', ')}` : '', synonyms.length ? `related terms ${synonyms.slice(0, 4).join(', ')}` : '']
        .filter(Boolean)
        .join('; ');
      bump(h.id, rel, { kind: 'lexical', text: `Lexical relevance ${(rel * 100).toFixed(0)}%: ${why}`, weight: rel }, original.length > 0 || rel > 0.5, h.matched);
    }

    // 3. Graph expansion from the strongest seeds.
    const seeds = [...acc.entries()]
      .filter(([, v]) => v.seed)
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, seedsN);
    for (const [path, v] of seeds) {
      const s = Math.min(1, v.score);
      for (const e of this.graph.out.get(path) ?? []) {
        if (e.kind === 'test') continue;
        const kind: SelectionReasonKind = e.kind === 'resource' ? 'resource' : e.kind === 'module' ? 'config' : 'dependency';
        bump(e.to, 0.45 * s, { kind, text: `${e.kind === 'resource' ? 'Resource used by' : 'Imported by'} \`${basename(path)}\``, weight: 0.45 * s });
      }
      const dependents = this.graph.dependents(path, ['import', 'include', 'resource']);
      for (const d of dependents.slice(0, 12)) {
        bump(d, 0.32 * s, { kind: 'dependent', text: `Imports \`${basename(path)}\` — may be affected by changes`, weight: 0.32 * s });
      }
      if (dependents.length > 12) warnings.push(`\`${path}\` has ${dependents.length} dependents; only 12 were added automatically.`);
      for (const t of this.graph.testsFor(path)) bump(t, 0.42 * s, { kind: 'test', text: `Test covering \`${basename(path)}\``, weight: 0.42 * s });
      const rec = this.index.files[path]!;
      const mod = rec.module ? this.index.modules.find((m) => m.id === rec.module) : undefined;
      if (mod?.buildFile) bump(mod.buildFile, 0.2 * s, { kind: 'config', text: `Build configuration of module ${mod.id}`, weight: 0.2 * s });
    }

    // 4. Configuration and docs relevant to the task vocabulary.
    const words = new Set(tokenize(task, { keepStopwords: true }));
    const wantsBuild = ['gradle', 'dependency', 'dependencie', 'build', 'version', 'library', 'plugin', 'sdk', 'package', 'cargo', 'npm'].some((w) => words.has(w));
    const wantsManifest = ['permission', 'manifest', 'activity', 'intent', 'deeplink', 'deep', 'service', 'receiver', 'launcher', 'screen'].some((w) => words.has(w));
    for (const c of this.index.config) {
      if (wantsBuild && ['gradle-build', 'gradle-settings', 'version-catalog', 'package-json', 'cargo', 'go-mod', 'python-project'].includes(c.kind)) {
        bump(c.path, 0.4, { kind: 'config', text: `Build configuration (${c.kind}) — task mentions build/dependency terms`, weight: 0.4 });
      }
      if (wantsManifest && c.kind === 'android-manifest') bump(c.path, 0.38, { kind: 'config', text: 'Android manifest — task mentions screens/permissions/components', weight: 0.38 });
    }
    for (const path of Object.keys(this.index.files)) {
      if (/^(ARCHITECTURE|PROJECT_CONTEXT|CONTRIBUTING)\.md$/i.test(basename(path)) || /^docs\/architecture/i.test(path)) {
        bump(path, 0.18, { kind: 'docs', text: 'Architecture documentation', weight: 0.18 });
      }
    }

    // 5. Normalize and shape output.
    const best = Math.max(1e-9, ...[...acc.values()].map((v) => v.score));
    const ranked: RankedFile[] = [...acc.entries()]
      .map(([path, v]) => {
        const rec = this.index.files[path]!;
        let score = v.score / best;
        if (/\.d\.ts$|\.min\.|generated|\.g\.dart$/.test(path)) score *= 0.5;
        return {
          path,
          score: Math.round(score * 1000) / 1000,
          reasons: v.reasons.sort((a, b) => b.weight - a.weight),
          matchedTerms: [...v.matched],
          dependencies: this.graph.dependencies(path, ['import', 'include']),
          dependents: this.graph.dependents(path, ['import', 'include']),
          tokens: rec.tokensEstimate,
          role: rec.role,
          seed: v.seed
        };
      })
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, limit);
    return { query, mentionedSymbols: [...new Set(mentionedSymbols)], mentionedPaths: [...new Set(mentionedPaths)], ranked, warnings };
  }
}
