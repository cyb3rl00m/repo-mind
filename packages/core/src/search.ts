/**
 * Lexical search: identifier-aware tokenization + BM25F over three fields (path, symbols, body).
 * No embeddings, no network — runs identically in the extension and the engine.
 */

const STOPWORDS = new Set(
  (
    'a an and are as at be but by for from has have if in into is it its of on or that the their then there these this to was were will with ' +
    'should would could can may might must shall do does did done make makes made add adds added use uses using used new get set when where which ' +
    'what who how why also just only some all any each other such than too very i we you they he she them our your my me us please want need ' +
    'implement implementation feature fix bug issue change update create code file files function functions class method'
  ).split(/\s+/)
);

/** Code-aware stop words that appear in nearly every file and carry no signal. */
const CODE_STOP = new Set(
  'import export return const let var val fun def public private protected static final void true false null none self this package class new override string int'.split(' ')
);

/** Light stemmer: plural/verb suffixes only, to keep identifiers recognizable. */
export function stem(t: string): string {
  if (t.length <= 4) return t;
  if (t.endsWith('ies')) return t.slice(0, -3) + 'y';
  if (t.endsWith('sses')) return t.slice(0, -2);
  if (t.endsWith('ing') && t.length > 6) return t.slice(0, -3);
  if (t.endsWith('ed') && t.length > 5) return t.slice(0, -2);
  if (t.endsWith('es') && /(ch|sh|x|z)es$/.test(t)) return t.slice(0, -2);
  if (t.endsWith('s') && !t.endsWith('ss') && !t.endsWith('us')) return t.slice(0, -1);
  return t;
}

/** Splits identifiers: `getUserProfile_v2` -> get, user, profile, v2. Keeps the joined lowercase form too. */
export function tokenize(text: string, opts: { keepStopwords?: boolean; code?: boolean } = {}): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)*|[0-9]{2,}/g)) {
    const word = m[0];
    const parts = word
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/[\s_]+/)
      .filter(Boolean);
    const lowered = parts.map((p) => p.toLowerCase());
    for (const p of lowered) {
      if (p.length < 2) continue;
      if (!opts.keepStopwords && (STOPWORDS.has(p) || (opts.code && CODE_STOP.has(p)))) continue;
      out.push(stem(p));
    }
    if (parts.length > 1) out.push(word.toLowerCase());
  }
  return out;
}

/** Developer synonyms for query expansion. Each group is symmetric. */
const SYNONYM_GROUPS: string[][] = [
  ['login', 'signin', 'auth', 'authentication', 'authenticate', 'credential', 'session'],
  ['logout', 'signout'],
  ['signup', 'register', 'registration', 'onboarding'],
  ['db', 'database', 'dao', 'repository', 'room', 'sqlite', 'sql', 'entity', 'table', 'migration', 'schema'],
  ['screen', 'activity', 'fragment', 'composable', 'page', 'view', 'ui', 'layout'],
  ['nav', 'navigation', 'navigate', 'navgraph', 'route', 'router', 'routing'],
  ['setting', 'settings', 'preference', 'preferences', 'config', 'configuration', 'datastore'],
  ['network', 'http', 'api', 'retrofit', 'client', 'request', 'endpoint', 'fetch', 'ktor', 'okhttp'],
  ['button', 'click', 'onclick', 'tap', 'press'],
  ['list', 'recyclerview', 'lazycolumn', 'adapter', 'items'],
  ['image', 'photo', 'picture', 'bitmap', 'camera'],
  ['notification', 'notify', 'push', 'alert'],
  ['test', 'tests', 'spec', 'junit', 'pytest'],
  ['error', 'exception', 'crash', 'failure', 'throw'],
  ['user', 'account', 'profile', 'member'],
  ['payment', 'billing', 'purchase', 'checkout', 'subscription'],
  ['theme', 'color', 'colors', 'style', 'dark', 'palette'],
  ['string', 'text', 'label', 'translation', 'localization', 'i18n'],
  ['viewmodel', 'state', 'stateflow', 'livedata', 'uistate'],
  ['permission', 'permissions', 'manifest'],
  ['background', 'worker', 'workmanager', 'service', 'job'],
  ['dependency', 'dependencies', 'gradle', 'build', 'catalog'],
  ['search', 'filter', 'query', 'find']
];
const SYNONYMS = new Map<string, string[]>();
for (const group of SYNONYM_GROUPS) {
  const stems = group.map(stem);
  for (const s of stems) SYNONYMS.set(s, [...new Set([...(SYNONYMS.get(s) ?? []), ...stems.filter((x) => x !== s)])]);
}

export interface QueryTerm {
  term: string;
  weight: number;
  /** Original (true) or expanded synonym (false). */
  original: boolean;
}

export function expandQuery(text: string): QueryTerm[] {
  const base = tokenize(text);
  const terms = new Map<string, QueryTerm>();
  for (const t of base) {
    const existing = terms.get(t);
    if (existing) existing.weight += 0.25;
    else terms.set(t, { term: t, weight: 1, original: true });
  }
  for (const t of [...terms.keys()]) {
    for (const syn of SYNONYMS.get(t) ?? []) if (!terms.has(syn)) terms.set(syn, { term: syn, weight: 0.35, original: false });
  }
  return [...terms.values()];
}

export interface DocFields {
  id: string;
  path: string;
  symbols: string;
  body: string;
}

interface FieldStats {
  tf: Map<string, number>;
  len: number;
}

const FIELD_WEIGHTS = { path: 3.0, symbols: 2.2, body: 1.0 } as const;
type Field = keyof typeof FIELD_WEIGHTS;

/** BM25F index over path / symbols / body. */
export class Bm25Index {
  private readonly docs = new Map<string, Record<Field, FieldStats>>();
  private readonly df = new Map<string, number>();
  private readonly avgLen: Record<Field, number> = { path: 0, symbols: 0, body: 0 };
  private readonly k1 = 1.2;
  private readonly b: Record<Field, number> = { path: 0.3, symbols: 0.5, body: 0.75 };

  constructor(docs: DocFields[]) {
    const totals: Record<Field, number> = { path: 0, symbols: 0, body: 0 };
    for (const d of docs) {
      const fields = {
        path: this.stats(tokenize(d.path.replace(/[/.]/g, ' '), { keepStopwords: true })),
        symbols: this.stats(tokenize(d.symbols, { code: true })),
        body: this.stats(tokenize(d.body, { code: true }))
      };
      this.docs.set(d.id, fields);
      const seen = new Set<string>();
      for (const f of Object.values(fields)) for (const t of f.tf.keys()) seen.add(t);
      for (const t of seen) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      for (const k of Object.keys(totals) as Field[]) totals[k] += fields[k].len;
    }
    const n = Math.max(1, docs.length);
    for (const k of Object.keys(totals) as Field[]) this.avgLen[k] = totals[k] / n || 1;
  }

  private stats(tokens: string[]): FieldStats {
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { tf, len: tokens.length };
  }

  get size(): number {
    return this.docs.size;
  }

  idf(term: string): number {
    const n = this.docs.size;
    const df = this.df.get(term) ?? 0;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  /** Scores all documents. Returns matched terms per doc for explanations. */
  search(query: QueryTerm[], limit = 200): { id: string; score: number; matched: string[] }[] {
    const results: { id: string; score: number; matched: string[] }[] = [];
    for (const [id, fields] of this.docs) {
      let score = 0;
      const matched: string[] = [];
      for (const q of query) {
        let wtf = 0;
        for (const f of Object.keys(FIELD_WEIGHTS) as Field[]) {
          const tf = fields[f].tf.get(q.term);
          if (!tf) continue;
          const norm = 1 - this.b[f] + this.b[f] * (fields[f].len / this.avgLen[f]);
          wtf += (FIELD_WEIGHTS[f] * tf) / norm;
        }
        if (wtf === 0) continue;
        score += q.weight * this.idf(q.term) * ((wtf * (this.k1 + 1)) / (wtf + this.k1));
        matched.push(q.term);
      }
      if (score > 0) results.push({ id, score, matched });
    }
    results.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return results.slice(0, limit);
  }
}
