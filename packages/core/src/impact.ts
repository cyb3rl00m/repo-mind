import { RepoGraph } from './graph.js';
import { basename } from './lang.js';
import type { RetrievalResult } from './retrieval.js';
import type { RepoIndex } from './types.js';

export type RiskLevel = 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL';

export interface RiskFactor {
  points: number;
  reason: string;
}

export interface ImpactReport {
  task: string;
  likelyToModify: { path: string; why: string }[];
  importers: { path: string; depth: number; of: string }[];
  dependentSymbols: { symbol: string; definedIn: string; usedIn: string[] }[];
  sharedComponents: { path: string; inDegree: number; modules: string[] }[];
  apiContracts: { path: string; why: string }[];
  database: { path: string; why: string }[];
  configuration: { path: string; why: string }[];
  tests: { path: string; covers: string }[];
  untestedFiles: string[];
  modulesAffected: string[];
  potentialRegressions: string[];
  risk: RiskLevel;
  riskScore: number;
  factors: RiskFactor[];
  coverageNotes: string[];
}

const API_PATTERNS: [RegExp, string][] = [
  [/@(GET|POST|PUT|PATCH|DELETE|HTTP)\s*\(/, 'Retrofit HTTP endpoint declarations'],
  [/@(RestController|Controller|RequestMapping|GetMapping|PostMapping)\b/, 'Spring web controller'],
  [/\b(app|router)\.(get|post|put|patch|delete)\s*\(/, 'HTTP route handlers'],
  [/@(app|router)\.(get|post|put|patch|delete)\s*\(/, 'FastAPI / Flask routes'],
  [/\bsyntax\s*=\s*"proto3"|^\s*service\s+\w+\s*\{/m, 'Protocol Buffers contract'],
  [/\btype\s+Query\s*\{|\bgql`/, 'GraphQL schema'],
  [/^openapi:|^swagger:/m, 'OpenAPI specification'],
  [/\bexport\s+(interface|type)\s+\w+(Request|Response|Dto|DTO|Payload)\b/, 'Exported request/response types'],
  [/\bdata\s+class\s+\w+(Request|Response|Dto|DTO)\b/, 'Network DTO classes'],
  [/#\[derive\([^)]*Serialize/, 'Serialized (serde) data contract'],
  [/@Serializable\b|@JsonClass\b|@SerializedName\b/, 'Serialized data contract (kotlinx/Moshi/Gson)']
];

const DB_PATTERNS: [RegExp, string][] = [
  [/@Entity\b/, 'Room entity'],
  [/@Dao\b/, 'Room DAO'],
  [/@Database\s*\(/, 'Room database definition (schema version)'],
  [/\b(CREATE|ALTER|DROP)\s+TABLE\b/i, 'SQL DDL'],
  [/\bRoom\.databaseBuilder\b/, 'Room database builder'],
  [/\bmodels\.Model\b|declarative_base\(|\bColumn\(/, 'ORM model (Django/SQLAlchemy)'],
  [/\bmodel\s+\w+\s*\{/, 'Prisma model'],
  [/\bsqlx::|diesel::|gorm\./, 'Database access layer'],
  [/\bSQLiteOpenHelper\b|\bContentValues\b/, 'SQLite helper']
];

export interface ImpactOptions {
  /** Override the automatically chosen files to modify. */
  targetFiles?: string[];
  maxDependents?: number;
}

function wordRe(name: string): RegExp {
  return new RegExp(`\\b${name.replace(/[$]/g, '\\$')}\\b`);
}

export function analyzeImpact(
  task: string,
  retrieval: RetrievalResult,
  index: RepoIndex,
  contents: Map<string, string>,
  opts: ImpactOptions = {}
): ImpactReport {
  const graph = new RepoGraph(index);
  const factors: RiskFactor[] = [];
  const coverageNotes: string[] = [];

  const likely =
    opts.targetFiles?.filter((p) => index.files[p]).map((p) => ({ path: p, why: 'Selected by user' })) ??
    (() => {
      // Only files that stand out from the rest are "likely to modify"; a flat score distribution
      // (e.g. a word that appears everywhere) must not turn the whole repo into targets.
      const candidates = retrieval.ranked.filter((r) => r.seed && ['source', 'resource', 'config', 'build', 'manifest', 'schema'].includes(r.role));
      const top = candidates[0]?.score ?? 0;
      const cutoff = Math.max(0.4, top * 0.6);
      return candidates
        .filter((r, i) => i === 0 || r.score >= cutoff)
        .slice(0, 6)
        .map((r) => ({ path: r.path, why: r.reasons[0]?.text ?? 'Relevant to task' }));
    })();
  if (likely.length === 0) coverageNotes.push('No file matched the task strongly; the impact analysis is low-confidence. Name concrete screens, classes or files in the task.');

  const likelyPaths = likely.map((l) => l.path);
  const closure = graph.reverseClosure(likelyPaths, 2, opts.maxDependents ?? 300);
  const importers: ImpactReport['importers'] = [];
  for (const [path, depth] of closure) {
    if (depth === 0) continue;
    const of = likelyPaths.find((l) => graph.dependents(l).includes(path)) ?? [...closure.keys()].find((k) => closure.get(k) === depth - 1 && graph.dependents(k).includes(path)) ?? '';
    importers.push({ path, depth, of });
  }
  importers.sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));

  // Symbols defined in target files and referenced elsewhere.
  const dependentSymbols: ImpactReport['dependentSymbols'] = [];
  for (const path of likelyPaths) {
    const rec = index.files[path]!;
    const exported = rec.symbols.filter((s) => s.exported && s.name.length > 3 && !['main', 'init', 'toString', 'equals', 'hashCode', 'render', 'build'].includes(s.name));
    for (const s of exported.slice(0, 40)) {
      const re = wordRe(s.name);
      const usedIn: string[] = [];
      for (const [p, text] of contents) {
        if (p === path || !index.files[p] || index.files[p]!.role === 'docs') continue;
        if (text.includes(s.name) && re.test(text)) {
          usedIn.push(p);
          if (usedIn.length >= 30) break;
        }
      }
      if (usedIn.length) dependentSymbols.push({ symbol: s.container ? `${s.container}.${s.name}` : s.name, definedIn: path, usedIn });
    }
  }
  dependentSymbols.sort((a, b) => b.usedIn.length - a.usedIn.length);

  // Shared components.
  const moduleOf = (p: string) => index.files[p]?.module ?? (p.includes('/') ? p.split('/')[0]! : '(root)');
  const sharedComponents: ImpactReport['sharedComponents'] = [];
  for (const path of new Set([...likelyPaths, ...likelyPaths.flatMap((p) => graph.dependencies(p, ['import']))])) {
    const deps = graph.dependents(path, ['import', 'include', 'resource']);
    const mods = [...new Set(deps.map(moduleOf))];
    if (deps.length >= 5 || mods.length >= 2) sharedComponents.push({ path, inDegree: deps.length, modules: mods });
  }

  const scan = (paths: Iterable<string>, patterns: [RegExp, string][]) => {
    const out: { path: string; why: string }[] = [];
    for (const p of paths) {
      const text = contents.get(p);
      if (!text) continue;
      const hits = patterns.filter(([re]) => re.test(text)).map(([, label]) => label);
      if (hits.length) out.push({ path: p, why: [...new Set(hits)].join(', ') });
    }
    return out;
  };
  const near = new Set([...closure.keys(), ...likelyPaths.flatMap((p) => graph.dependencies(p))]);
  const apiContracts = scan(near, API_PATTERNS);
  const database = scan(near, DB_PATTERNS);
  for (const p of near) {
    const rec = index.files[p];
    if (rec?.role === 'schema' && !database.some((d) => d.path === p)) database.push({ path: p, why: 'Schema / migration file' });
  }

  // Configuration of affected modules.
  const modulesAffected = [...new Set([...likelyPaths, ...importers.filter((i) => i.depth === 1).map((i) => i.path)].map(moduleOf))];
  const configuration: ImpactReport['configuration'] = [];
  for (const m of index.modules) {
    if (!modulesAffected.includes(m.id)) continue;
    if (m.buildFile) configuration.push({ path: m.buildFile, why: `Build configuration of affected module ${m.id}` });
    if (m.android?.manifest && likelyPaths.some((p) => ['activity', 'fragment', 'composable'].some((k) => index.files[p]!.symbols.some((s) => s.kind === k)))) {
      configuration.push({ path: m.android.manifest, why: 'Screens/components may need manifest registration' });
    }
  }
  for (const p of likelyPaths) {
    const role = index.files[p]!.role;
    if ((role === 'config' || role === 'build' || role === 'manifest') && !configuration.some((c) => c.path === p)) configuration.push({ path: p, why: 'Configuration file targeted directly' });
  }

  // Tests.
  const tests: ImpactReport['tests'] = [];
  const untestedFiles: string[] = [];
  for (const p of likelyPaths) {
    const t = graph.testsFor(p);
    if (t.length === 0 && index.files[p]!.role === 'source') untestedFiles.push(p);
    for (const x of t) tests.push({ path: x, covers: p });
  }
  for (const imp of importers.filter((i) => i.depth === 1)) for (const x of graph.testsFor(imp.path)) if (!tests.some((t) => t.path === x)) tests.push({ path: x, covers: imp.path });

  // Potential regressions (human-readable).
  const potentialRegressions: string[] = [];
  for (const d of dependentSymbols.slice(0, 8)) {
    potentialRegressions.push(`\`${d.symbol}\` (in ${basename(d.definedIn)}) is referenced by ${d.usedIn.length} other file(s); changing its name, parameters or return type requires updating ${d.usedIn.slice(0, 4).map(basename).join(', ')}${d.usedIn.length > 4 ? ', …' : ''}.`);
  }
  for (const s of sharedComponents.slice(0, 5)) potentialRegressions.push(`\`${s.path}\` is shared by ${s.inDegree} file(s) across ${s.modules.length} module(s): ${s.modules.slice(0, 4).join(', ')}.`);
  if (database.length) potentialRegressions.push('Database code is in the blast radius: schema changes need a migration (Room: bump @Database version and add a Migration) or existing installs may crash or lose data.');
  if (apiContracts.length) potentialRegressions.push('API/serialization contracts are nearby: renaming fields or endpoints breaks clients or persisted data.');
  if (untestedFiles.length) potentialRegressions.push(`No tests found for: ${untestedFiles.slice(0, 5).join(', ')}. Behaviour changes there will not be caught automatically.`);

  // Risk scoring (transparent heuristic).
  if (likelyPaths.length > 3) factors.push({ points: Math.min(3, likelyPaths.length - 3), reason: `${likelyPaths.length} files likely need changes` });
  const maxFanIn = Math.max(0, ...likelyPaths.map((p) => graph.dependents(p).length));
  if (maxFanIn >= 25) factors.push({ points: 3, reason: `A target file has ${maxFanIn} direct dependents` });
  else if (maxFanIn >= 10) factors.push({ points: 2, reason: `A target file has ${maxFanIn} direct dependents` });
  else if (maxFanIn >= 3) factors.push({ points: 1, reason: `A target file has ${maxFanIn} direct dependents` });
  if (sharedComponents.some((s) => likelyPaths.includes(s.path))) factors.push({ points: 2, reason: 'A shared component is a direct target' });
  if (database.some((d) => likelyPaths.includes(d.path))) factors.push({ points: 3, reason: 'Database schema/access code is a direct target' });
  else if (database.length) factors.push({ points: 1, reason: 'Database code is within two dependency hops' });
  if (apiContracts.some((d) => likelyPaths.includes(d.path))) factors.push({ points: 2, reason: 'An API/serialization contract is a direct target' });
  if (likelyPaths.some((p) => ['build', 'manifest'].includes(index.files[p]!.role))) factors.push({ points: 2, reason: 'Build scripts or the Android manifest are direct targets' });
  if (modulesAffected.length >= 2) factors.push({ points: 1, reason: `Changes span ${modulesAffected.length} modules` });
  if (likelyPaths.length && untestedFiles.length === likelyPaths.filter((p) => index.files[p]!.role === 'source').length && untestedFiles.length > 0) {
    factors.push({ points: 2, reason: 'None of the target source files have tests' });
  } else if (untestedFiles.length) factors.push({ points: 1, reason: `${untestedFiles.length} target file(s) have no tests` });
  const unresolvedNear = likelyPaths.reduce((a, p) => a + index.files[p]!.imports.filter((i) => i.unresolved).length, 0);
  if (unresolvedNear) {
    factors.push({ points: 1, reason: `${unresolvedNear} imports in target files could not be resolved (graph may be incomplete)` });
    coverageNotes.push('Some imports in the target files are unresolved, so importer lists may be incomplete.');
  }
  if (index.skipped.some((s) => s.reason === 'limit')) coverageNotes.push('The repository index hit its file limit; impact coverage is incomplete.');
  if (likelyPaths.some((p) => index.files[p]!.fidelity === 'lexical')) coverageNotes.push('Target files were parsed lexically (not full AST); symbol usage is matched by name and may include false positives.');
  coverageNotes.push('Dynamic dispatch, reflection, dependency-injection wiring and generated code are not traced.');

  const riskScore = factors.reduce((a, f) => a + f.points, 0);
  const risk: RiskLevel = riskScore >= 9 ? 'CRITICAL' : riskScore >= 6 ? 'HIGH' : riskScore >= 3 ? 'MODERATE' : 'LOW';

  return {
    task,
    likelyToModify: likely,
    importers: importers.slice(0, 60),
    dependentSymbols: dependentSymbols.slice(0, 25),
    sharedComponents,
    apiContracts,
    database,
    configuration,
    tests,
    untestedFiles,
    modulesAffected,
    potentialRegressions,
    risk,
    riskScore,
    factors,
    coverageNotes
  };
}

export function renderImpactMarkdown(r: ImpactReport): string {
  const out: string[] = [];
  out.push(`### Change Impact Report — risk: **${r.risk}** (score ${r.riskScore}, heuristic)`);
  out.push('');
  out.push('Risk factors:');
  if (r.factors.length === 0) out.push('- none detected');
  for (const f of r.factors) out.push(`- +${f.points}: ${f.reason}`);
  const section = (title: string, rows: string[]) => {
    out.push('', `**${title}**`);
    if (rows.length === 0) out.push('- none found');
    else out.push(...rows.map((x) => `- ${x}`));
  };
  section('Files likely to modify', r.likelyToModify.map((l) => `\`${l.path}\` — ${l.why}`));
  section('Files importing them', r.importers.slice(0, 25).map((i) => `\`${i.path}\` (depth ${i.depth}${i.of ? `, via ${basename(i.of)}` : ''})`));
  section('Symbols used elsewhere', r.dependentSymbols.slice(0, 12).map((d) => `\`${d.symbol}\` used in ${d.usedIn.length} file(s): ${d.usedIn.slice(0, 5).map((u) => `\`${u}\``).join(', ')}`));
  section('Shared components', r.sharedComponents.map((s) => `\`${s.path}\` — ${s.inDegree} dependents, modules: ${s.modules.join(', ')}`));
  section('API contracts', r.apiContracts.map((a) => `\`${a.path}\` — ${a.why}`));
  section('Database', r.database.map((a) => `\`${a.path}\` — ${a.why}`));
  section('Configuration', r.configuration.map((a) => `\`${a.path}\` — ${a.why}`));
  section('Relevant tests', r.tests.map((t) => `\`${t.path}\` covers \`${t.covers}\``));
  section('Potential regressions', r.potentialRegressions);
  section('Coverage limits', r.coverageNotes);
  return out.join('\n');
}
