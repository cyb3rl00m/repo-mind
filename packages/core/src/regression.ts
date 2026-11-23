import { applyFilePatch, type FilePatch, type ParsedPatch } from './diff.js';
import { RepoGraph } from './graph.js';
import { basename, detectLanguage, detectRole } from './lang.js';
import { parseFile } from './parsers/index.js';
import { detectSecrets, redactSecrets } from './secrets.js';
import type { RepoIndex, SymbolInfo } from './types.js';

export type FindingSeverity = 'info' | 'low' | 'medium' | 'high';

export type FindingCategory =
  | 'apply'
  | 'removed-symbol'
  | 'signature'
  | 'return-type'
  | 'import'
  | 'interface'
  | 'config'
  | 'dependency'
  | 'resource'
  | 'schema'
  | 'unrelated'
  | 'destructive'
  | 'placeholder'
  | 'security'
  | 'tests';

export interface RegressionFinding {
  severity: FindingSeverity;
  category: FindingCategory;
  path: string;
  line?: number;
  title: string;
  /** Why the warning exists. Findings are heuristics, not proven bugs. */
  explanation: string;
}

export interface RegressionReport {
  findings: RegressionFinding[];
  checklist: string[];
  filesChanged: { path: string; status: FilePatch['status']; additions: number; deletions: number; applies: boolean; fuzzy: boolean }[];
  /** New content per file after applying the patch in memory (null = deleted, undefined = failed). */
  preview: Record<string, string | null>;
  summary: { high: number; medium: number; low: number; info: number; verdict: 'blocked' | 'review-carefully' | 'looks-reasonable' };
}

export interface RegressionOptions {
  /** Files the plan/context expected to change. Other modified files are flagged as unrelated. */
  expectedFiles?: string[];
}

const PLACEHOLDER_RES: [RegExp, string][] = [
  [/^\s*(\/\/|#|\/\*|<!--)\s*\.\.\.\s*(rest|existing|remaining|other|previous|unchanged|same)\b/i, 'Elided-code placeholder (“… rest of code …”) — applying it would DELETE the original code it stands for'],
  [/^\s*(\/\/|#)\s*(rest of|existing|remaining) (the )?(code|implementation|file|methods?)\b/i, 'Elided-code placeholder — original code would be lost'],
  [/^\s*\.\.\.\s*$/, 'Bare `...` line — usually an elision placeholder, not code'],
  [/\bTODO\s*\(\s*\)|\bTODO\s*\(\s*"|\bunimplemented!\s*\(|\btodo!\s*\(|raise NotImplementedError|throw new Error\(['"]not implemented|NotImplementedError\(\)|UnsupportedOperationException\(\s*"Not (yet )?implemented/i, 'Unimplemented stub'],
  [/\/\/\s*(TODO|FIXME)\b|#\s*(TODO|FIXME)\b/, 'New TODO/FIXME left in the change']
];

const DESTRUCTIVE_RES: [RegExp, string][] = [
  [/\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i, 'Drops database objects'],
  [/\bTRUNCATE\s+TABLE\b/i, 'Truncates a table'],
  [/\bDELETE\s+FROM\s+\w+\s*;?\s*["'`]?\s*\)?\s*;?\s*$/i, 'DELETE without WHERE clause'],
  [/fallbackToDestructiveMigration/, 'Room destructive migration — wipes user data on schema change'],
  [/\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/, 'Recursive force delete in a script'],
  [/\bdeleteRecursively\(\)|shutil\.rmtree|fs\.rmSync\([^)]*recursive|os\.RemoveAll|remove_dir_all|FileUtils\.deleteDirectory/, 'Recursive filesystem deletion'],
  [/git\s+push\s+(-f|--force)|git\s+reset\s+--hard|git\s+clean\s+-[a-z]*f/, 'Destructive git command'],
  [/\bclearAllTables\(\)|\.deleteAll\(\)/, 'Clears all stored data']
];

const SECURITY_RES: [RegExp, string][] = [
  [/\beval\s*\(|new Function\s*\(/, 'Dynamic code evaluation'],
  [/Runtime\.getRuntime\(\)\.exec|ProcessBuilder\(|child_process|subprocess\.[a-z]+\([^)]*shell\s*=\s*True|os\.system\(/, 'Executes external commands'],
  [/\.innerHTML\s*=|dangerouslySetInnerHTML|v-html=/, 'Injects raw HTML (XSS risk)'],
  [/usesCleartextTraffic\s*=\s*"true"|android:exported\s*=\s*"true"/, 'Android manifest attribute with security impact'],
  [/TrustAllCerts|X509TrustManager|HostnameVerifier\s*\{[^}]*true|verify\s*=\s*False|rejectUnauthorized\s*:\s*false|InsecureSkipVerify\s*:\s*true|danger_accept_invalid_certs/, 'Disables TLS certificate verification'],
  [/rawQuery\s*\(\s*"[^"]*"\s*\+|execSQL\s*\(\s*"[^"]*"\s*\+|execute\s*\(\s*f?["'][^"']*(\{|%s|"\s*\+)/, 'SQL built by string concatenation (injection risk)'],
  [/Log\.[dviwe]\([^)]*(password|token|secret)|console\.log\([^)]*(password|token|secret)|print\([^)]*(password|token|secret)/i, 'Logs sensitive values'],
  [/["']http:\/\/(?!localhost|127\.0\.0\.1|10\.0\.2\.2)/, 'Plain-HTTP URL']
];

const DEP_LINE = /^\s*(implementation|api|kapt|ksp|compileOnly|runtimeOnly|testImplementation|androidTestImplementation|debugImplementation|classpath|id|alias)\b|^\s*"[@\w/.-]+"\s*:\s*"[\^~]?[\d*x]|^\s*[\w-]+\s*=\s*(\{\s*)?(version\s*=\s*)?"[\^~=]?\d|^\s*[\w.-]+\s*=\s*\{\s*(module|group|id)\s*=|^\s*require\s+[\w.-]+\.[\w/.-]+\s+v\d|^\s*[\w.-]+(==|>=|~=)\d/;

function key(s: SymbolInfo): string {
  return `${s.container ?? ''}::${s.name}::${s.kind === 'method' || s.kind === 'function' || s.kind === 'composable' ? 'fn' : s.kind}`;
}

function normSig(s: string): string {
  return s.replace(/\s+/g, ' ').replace(/\s*([(),:<>{}=])\s*/g, '$1').replace(/,\)/g, ')').trim();
}

function params(sig: string): string {
  const open = sig.indexOf('(');
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < sig.length; i++) {
    if (sig[i] === '(') depth++;
    else if (sig[i] === ')' && --depth === 0) return normSig(sig.slice(open, i + 1));
  }
  return normSig(sig.slice(open));
}

function addedLines(fp: FilePatch): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  for (const h of fp.hunks) {
    let n = h.newStart;
    for (const l of h.lines) {
      if (l.type === '+') out.push({ text: l.text, line: n });
      if (l.type !== '-') n++;
    }
  }
  return out;
}

function removedLines(fp: FilePatch): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  for (const h of fp.hunks) {
    let n = h.oldStart;
    for (const l of h.lines) {
      if (l.type === '-') out.push({ text: l.text, line: n });
      if (l.type !== '+') n++;
    }
  }
  return out;
}

/**
 * Compares the repository against a proposed patch and reports risky changes before application.
 */
export function analyzeRegression(patch: ParsedPatch, index: RepoIndex, contents: Map<string, string>, opts: RegressionOptions = {}): RegressionReport {
  const graph = new RepoGraph(index);
  const findings: RegressionFinding[] = [];
  const preview: Record<string, string | null> = {};
  const filesChanged: RegressionReport['filesChanged'] = [];
  const changedPaths = new Set(patch.files.map((f) => f.path));
  const deletedPaths = new Set(patch.files.filter((f) => f.status === 'deleted' || f.status === 'renamed').map((f) => f.oldPath!));
  const add = (f: RegressionFinding) => findings.push(f);

  // Usage lookup across the repo (post-patch content for changed files).
  const usages = (name: string, exclude: string): string[] => {
    const re = new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`);
    const out: string[] = [];
    for (const [p, text] of contents) {
      if (p === exclude || deletedPaths.has(p)) continue;
      const t = preview[p] !== undefined ? preview[p] ?? '' : text;
      if (t.includes(name) && re.test(t)) out.push(p);
      if (out.length >= 25) break;
    }
    return out;
  };

  // Pass 1: apply all files in memory.
  for (const fp of patch.files) {
    const source = fp.status === 'added' ? null : contents.get(fp.oldPath ?? fp.path) ?? null;
    if (fp.status !== 'added' && source === null) {
      add({ severity: 'high', category: 'apply', path: fp.path, title: 'File not found in the indexed repository', explanation: 'The patch modifies a file RepoMind does not know. The index may be stale (refresh it) or the model invented the path.' });
      filesChanged.push({ path: fp.path, status: fp.status, additions: fp.additions, deletions: fp.deletions, applies: false, fuzzy: false });
      continue;
    }
    const res = applyFilePatch(source, fp);
    if (!res.ok) {
      for (const f of res.failed) add({ severity: 'high', category: 'apply', path: fp.path, title: 'Hunk does not apply', explanation: `${f.reason} The model probably worked from outdated or invented code.` });
    } else {
      preview[fp.path] = res.content;
      if (res.fuzzy.length) {
        add({ severity: 'low', category: 'apply', path: fp.path, title: `${res.fuzzy.length} hunk(s) applied with offset/whitespace fuzz`, explanation: 'Context matched at a different line or only after ignoring whitespace. Review the placement.' });
      }
    }
    filesChanged.push({ path: fp.path, status: fp.status, additions: fp.additions, deletions: fp.deletions, applies: res.ok, fuzzy: res.fuzzy.length > 0 });
  }

  // Names declared by the patched files (new declarations can satisfy new imports).
  const patchDeclared = new Set<string>();
  for (const [p, text] of Object.entries(preview)) {
    if (text === null) continue;
    for (const s of parseFile(p, detectLanguage(p), text).symbols) patchDeclared.add(s.name);
  }

  // Pass 2: semantic comparison per file.
  for (const fp of patch.files) {
    const oldPath = fp.oldPath ?? fp.path;
    const rec = index.files[oldPath];
    const language = detectLanguage(fp.path);
    const role = rec?.role ?? detectRole(fp.path, language);
    const after = preview[fp.path];
    const added = addedLines(fp);
    const removed = removedLines(fp);

    // Deleted / renamed files that others import.
    if (fp.status === 'deleted' || fp.status === 'renamed') {
      const importers = graph.dependents(oldPath).filter((d) => !changedPaths.has(d));
      add({
        severity: importers.length ? 'high' : 'medium',
        category: fp.status === 'deleted' ? 'destructive' : 'import',
        path: oldPath,
        title: fp.status === 'deleted' ? 'File deleted' : `File renamed to ${fp.newPath}`,
        explanation: importers.length
          ? `${importers.length} unchanged file(s) depend on it: ${importers.slice(0, 5).join(', ')}. They will break unless updated.`
          : 'No indexed dependents, but verify nothing loads it dynamically (reflection, manifest, resources).'
      });
      if (/(^|\/)res\//.test(oldPath)) {
        const resKey = /res\/([a-z]+)(?:-[\w-]+)?\/([\w.]+)\.\w+$/.exec(oldPath);
        if (resKey) {
          const ref = `${resKey[1]}/${resKey[2]}`;
          const users = Object.values(index.files).filter((f) => f.resourceRefs.includes(ref) && !changedPaths.has(f.path)).map((f) => f.path);
          if (users.length) add({ severity: 'high', category: 'resource', path: oldPath, title: `Deleted resource @${ref} is still referenced`, explanation: `Referenced from ${users.slice(0, 5).join(', ')}. The build (R class / AAPT) will fail.` });
        }
      }
    }

    // Symbol comparison.
    if (rec && after !== undefined && after !== null && rec.fidelity !== 'none') {
      const newParse = parseFile(fp.path, language, after);
      const oldMap = new Map(rec.symbols.map((s) => [key(s), s]));
      const newMap = new Map(newParse.symbols.map((s) => [key(s), s]));
      for (const [k, s] of oldMap) {
        if (language === 'markdown') break;
        const n = newMap.get(k);
        if (!n) {
          const renamedTo = newParse.symbols.find((x) => x.kind === s.kind && x.container === s.container && !oldMap.has(key(x)) && params(x.signature) === params(s.signature));
          const users = s.exported ? usages(s.name, oldPath) : [];
          add({
            severity: users.length ? 'high' : s.exported ? 'medium' : 'low',
            category: 'removed-symbol',
            path: fp.path,
            line: s.line,
            title: `Removed ${s.kind} \`${s.container ? s.container + '.' : ''}${s.name}\`${renamedTo ? ` (renamed to \`${renamedTo.name}\`?)` : ''}`,
            explanation: users.length
              ? `Still referenced by name in ${users.length} file(s): ${users.slice(0, 5).join(', ')}.`
              : s.exported
                ? 'It was public; no other indexed file references it by name, but external callers, reflection or generated code might.'
                : 'Private declaration removed; check it was intended.'
          });
          continue;
        }
        if (['function', 'method', 'composable'].includes(s.kind)) {
          if (params(s.signature) !== params(n.signature)) {
            const users = s.exported ? usages(s.name, oldPath) : [];
            add({
              severity: users.length ? 'high' : 'medium',
              category: 'signature',
              path: fp.path,
              line: n.line,
              title: `Signature of \`${s.name}\` changed`,
              explanation: `Before: \`${normSig(s.signature).slice(0, 160)}\`\nAfter: \`${normSig(n.signature).slice(0, 160)}\`${users.length ? `\nCall sites in ${users.length} file(s) may need updates: ${users.slice(0, 5).join(', ')}.` : ''}`
            });
          }
          if ((s.returnType ?? '') !== (n.returnType ?? '') && (s.returnType || n.returnType)) {
            add({
              severity: s.exported ? 'medium' : 'low',
              category: 'return-type',
              path: fp.path,
              line: n.line,
              title: `Return type of \`${s.name}\` changed: ${s.returnType ?? '(inferred)'} → ${n.returnType ?? '(inferred)'}`,
              explanation: 'Callers that use the result may no longer compile or may behave differently.'
            });
          }
        } else if (['interface', 'trait', 'class', 'struct', 'record', 'entity'].includes(s.kind) && normSig(s.signature) !== normSig(n.signature)) {
          add({
            severity: s.kind === 'entity' ? 'high' : 'medium',
            category: s.kind === 'entity' ? 'schema' : 'interface',
            path: fp.path,
            line: n.line,
            title: `Declaration of ${s.kind} \`${s.name}\` changed`,
            explanation: `Header/constructor changed. Implementations, subclasses and constructors calls must still match.${s.kind === 'entity' ? ' This is a Room entity: a schema migration is required.' : ''}`
          });
        }
      }
      // Members added to interfaces force all implementations to change.
      for (const [k, n] of newMap) {
        if (oldMap.has(k) || !n.container) continue;
        const parent = rec.symbols.find((s) => s.name === n.container && (s.kind === 'interface' || s.kind === 'trait'));
        if (parent && !/\{|=>|=\s/.test(n.signature) && !/\bdefault\b/.test(n.signature)) {
          add({ severity: 'medium', category: 'interface', path: fp.path, line: n.line, title: `New abstract member \`${parent.name}.${n.name}\``, explanation: 'Every implementation of this interface must implement the new member or compilation fails.' });
        }
      }

      // New internal imports that do not resolve.
      for (const imp of newParse.imports) {
        if (!added.some((a) => a.line === imp.line)) continue;
        if ((language === 'typescript' || language === 'javascript') && imp.spec.startsWith('.')) {
          const dir = fp.path.includes('/') ? fp.path.slice(0, fp.path.lastIndexOf('/')) : '';
          const base = (dir ? dir + '/' : '') + imp.spec;
          const norm = base.split('/').reduce<string[]>((acc, seg) => (seg === '..' ? acc.slice(0, -1) : seg === '.' || !seg ? acc : [...acc, seg]), []).join('/');
          const exts = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.d.ts', '/index.ts', '/index.tsx', '/index.js'];
          const stem = norm.replace(/\.(m|c)?js$/, '');
          const exists = exts.some((e) => index.files[norm + e] || index.files[stem + e] || changedPaths.has(norm + e) || changedPaths.has(stem + e));
          if (!exists) add({ severity: 'high', category: 'import', path: fp.path, line: imp.line, title: `Import \`${imp.spec}\` does not resolve`, explanation: 'No file with that path exists in the repository or in this patch.' });
        } else if ((language === 'kotlin' || language === 'java') && !imp.spec.endsWith('*')) {
          const simple = imp.spec.split('.').pop()!;
          const root = imp.spec.split('.').slice(0, 2).join('.');
          const internalRoot = Object.values(index.files).some((f) => f.pkg?.startsWith(root));
          const known = Boolean(index.symbolIndex[simple]) || patchDeclared.has(simple);
          if (internalRoot && !known && !/\.R$|BuildConfig$|Binding$|\.databinding\./.test(imp.spec)) {
            add({ severity: 'high', category: 'import', path: fp.path, line: imp.line, title: `Import \`${imp.spec}\` refers to an unknown symbol`, explanation: `No declaration named \`${simple}\` exists in the indexed project packages (${root}.*). The model may have invented it.` });
          }
        } else if (language === 'python' && imp.spec.startsWith('.')) {
          const known = imp.names?.every((n) => index.symbolIndex[n] || n === '*' || Object.keys(index.files).some((p) => p.endsWith(`/${n}.py`)));
          if (!known) add({ severity: 'medium', category: 'import', path: fp.path, line: imp.line, title: `Relative import \`from ${imp.spec} import ${imp.names?.join(', ')}\` may not resolve`, explanation: 'At least one imported name was not found in the index.' });
        }
      }
    }

    // Line-level scans of added content.
    for (const a of added) {
      for (const [re, label] of PLACEHOLDER_RES) if (re.test(a.text)) add({ severity: label.includes('DELETE') || label.includes('lost') ? 'high' : label.startsWith('Unimplemented') ? 'high' : 'low', category: 'placeholder', path: fp.path, line: a.line, title: label, explanation: `Added line: \`${redactSecrets(a.text.trim()).text.slice(0, 120)}\`` });
      for (const [re, label] of DESTRUCTIVE_RES) if (re.test(a.text)) add({ severity: 'high', category: 'destructive', path: fp.path, line: a.line, title: label, explanation: `Added line: \`${redactSecrets(a.text.trim()).text.slice(0, 120)}\`` });
      for (const [re, label] of SECURITY_RES) if (re.test(a.text)) add({ severity: 'medium', category: 'security', path: fp.path, line: a.line, title: label, explanation: `Added line: \`${redactSecrets(a.text.trim()).text.slice(0, 120)}\`` });
    }
    const secretHits = detectSecrets(added.map((a) => a.text).join('\n'));
    if (secretHits.length) add({ severity: 'high', category: 'security', path: fp.path, title: `Patch adds ${secretHits.length} secret-looking value(s)`, explanation: `Types: ${[...new Set(secretHits.map((s) => s.type))].join(', ')}. Never commit credentials.` });

    // Large deletions within a modified file.
    const oldLines = rec?.lines ?? 0;
    if (fp.status === 'modified' && oldLines > 20 && fp.deletions / oldLines > 0.6 && fp.additions < fp.deletions * 0.5) {
      add({ severity: 'high', category: 'destructive', path: fp.path, title: `Removes ${fp.deletions} of ${oldLines} lines`, explanation: 'Most of the file is deleted and little is added back. Typical of a truncated model answer.' });
    }

    // Config / dependency / schema changes.
    if (role === 'config' || role === 'build' || role === 'manifest') {
      add({ severity: role === 'build' || role === 'manifest' ? 'medium' : 'low', category: 'config', path: fp.path, title: `${role === 'manifest' ? 'Android manifest' : role === 'build' ? 'Build script' : 'Configuration'} modified`, explanation: 'Configuration changes affect the whole module/app. Confirm each changed line was requested.' });
      const depAdds = added.filter((a) => DEP_LINE.test(a.text)).map((a) => a.text.trim());
      const depRemovals = removed.filter((r) => DEP_LINE.test(r.text)).map((r) => r.text.trim());
      if (depAdds.length || depRemovals.length) {
        add({
          severity: depRemovals.length ? 'medium' : 'low',
          category: 'dependency',
          path: fp.path,
          title: `Dependencies changed (+${depAdds.length} / −${depRemovals.length})`,
          explanation: [...depAdds.map((d) => `+ ${d}`), ...depRemovals.map((d) => `− ${d}`)].slice(0, 12).join('\n') + '\nVerify versions exist, are compatible, and that removed dependencies are unused.'
        });
      }
    }
    if (role === 'schema' || added.some((a) => /@(Entity|Database|ColumnInfo|PrimaryKey)\b|\b(CREATE|ALTER)\s+TABLE\b|\bversion\s*=\s*\d+/.test(a.text) && /@Database|@Entity|TABLE|ColumnInfo|PrimaryKey/.test(a.text))) {
      const hasMigration = patch.files.some((f) => /migration/i.test(f.path) || addedLines(f).some((a) => /Migration\s*\(|addMigrations|AutoMigration/.test(a.text)));
      add({
        severity: hasMigration ? 'medium' : 'high',
        category: 'schema',
        path: fp.path,
        title: 'Database schema change',
        explanation: hasMigration ? 'A migration appears to be included; verify it covers every column/table change.' : 'No migration found in the patch. Existing installs will crash on upgrade (Room) or data will be inconsistent.'
      });
    }

    // Unrelated modifications.
    if (opts.expectedFiles?.length) {
      const expected = new Set(opts.expectedFiles);
      const neighbours = new Set(opts.expectedFiles.flatMap((p) => [...graph.dependencies(p), ...graph.dependents(p)]));
      if (!expected.has(fp.path) && !expected.has(oldPath)) {
        add({
          severity: neighbours.has(fp.path) ? 'low' : 'medium',
          category: 'unrelated',
          path: fp.path,
          title: neighbours.has(fp.path) ? 'File outside the plan (but adjacent)' : 'File outside the approved plan',
          explanation: neighbours.has(fp.path) ? 'Not listed in the plan, but it is a direct dependency/dependent of a planned file.' : 'Not listed in the plan and not connected to planned files. Unrequested changes are a common source of regressions.'
        });
      }
    }
  }

  // Checklist.
  const checklist: string[] = [];
  const modules = [...new Set(patch.files.map((f) => index.files[f.oldPath ?? f.path]?.module).filter(Boolean))] as string[];
  if (modules.length) checklist.push(`Build affected module(s): ${modules.join(', ')}`);
  else checklist.push('Run the project build');
  for (const fp of patch.files) {
    const tests = graph.testsFor(fp.oldPath ?? fp.path);
    if (tests.length) checklist.push(`Run tests for ${basename(fp.path)}: ${tests.slice(0, 4).join(', ')}`);
    else if (index.files[fp.oldPath ?? fp.path]?.role === 'source') checklist.push(`No automated test covers ${fp.path} — test it manually or add a test`);
  }
  const dependents = [...new Set(patch.files.flatMap((f) => graph.dependents(f.oldPath ?? f.path)))].filter((d) => !changedPaths.has(d));
  if (dependents.length) checklist.push(`Re-check ${dependents.length} dependent file(s) that were not changed: ${dependents.slice(0, 6).join(', ')}${dependents.length > 6 ? ', …' : ''}`);
  if (findings.some((f) => f.category === 'schema')) checklist.push('Test an upgrade install with existing data (schema migration)');
  if (patch.files.some((f) => /(^|\/)res\/(layout|navigation|menu)\//.test(f.path))) checklist.push('Open the affected screens on a device/emulator and check layout + navigation');
  if (findings.some((f) => f.category === 'dependency')) checklist.push('Run a clean build to verify dependency resolution');
  if (findings.some((f) => f.category === 'security')) checklist.push('Review the security findings before merging');

  const count = (s: FindingSeverity) => findings.filter((f) => f.severity === s).length;
  const high = count('high');
  const blocked = findings.some((f) => f.category === 'apply' && f.severity === 'high');
  const order: Record<FindingSeverity, number> = { high: 0, medium: 1, low: 2, info: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.path.localeCompare(b.path));
  return {
    findings,
    checklist,
    filesChanged,
    preview,
    summary: { high, medium: count('medium'), low: count('low'), info: count('info'), verdict: blocked ? 'blocked' : high > 0 || count('medium') > 2 ? 'review-carefully' : 'looks-reasonable' }
  };
}
