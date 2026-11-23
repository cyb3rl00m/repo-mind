import { basename, detectLanguage, detectRole, dirname, extname, isTestPath } from './lang.js';
import { parseFile, type BuildInfo, type ParseResult } from './parsers/index.js';
import { detectSecrets, redactSecrets } from './secrets.js';
import { detectInjection } from './injection.js';
import { estimateTokens } from './tokens.js';
import type {
  ConfigEntry,
  EntryPoint,
  FileRecord,
  GraphEdge,
  ModuleInfo,
  RepoIndex,
  RepoStats,
  ResolvedImport,
  SkippedFile,
  SourceFile
} from './types.js';

export const INDEX_VERSION = 3;

interface Parsed {
  file: SourceFile;
  record: FileRecord;
  parse: ParseResult;
}

const TS_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.d.ts', '.js', '.jsx', '.mjs', '.cjs'];

function joinPath(dir: string, rel: string): string | null {
  const parts = dir ? dir.split('/') : [];
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** Builds the full repository index. Pure function: same input -> same output. */
export function buildIndex(
  files: SourceFile[],
  skipped: SkippedFile[] = [],
  onProgress?: (done: number, total: number) => void
): RepoIndex {
  const parsed: Parsed[] = [];
  const total = files.length;
  files.forEach((file, i) => {
    const language = detectLanguage(file.path);
    const role = detectRole(file.path, language);
    const parse = parseFile(file.path, language, file.content);
    // Signatures are shown in outlines and prompts: never let a secret ride along.
    for (const s of parse.symbols) if (s.signature.length > 12) s.signature = redactSecrets(s.signature).text;
    const lines = file.content.length === 0 ? 0 : file.content.split('\n').length;
    const record: FileRecord = {
      path: file.path,
      language,
      role,
      size: file.size,
      lines,
      tokensEstimate: estimateTokens(file.content),
      fidelity: parse.fidelity,
      pkg: parse.pkg,
      symbols: parse.symbols,
      imports: [],
      resourceRefs: parse.resourceRefs,
      secretFindings: detectSecrets(file.content),
      injectionFindings: role === 'resource' ? [] : detectInjection(file.content),
      notes: [...parse.notes]
    };
    parsed.push({ file, record, parse });
    if (onProgress && (i % 250 === 0 || i === total - 1)) onProgress(i + 1, total);
  });

  const byPath = new Map(parsed.map((p) => [p.file.path, p]));
  const paths = new Set(byPath.keys());
  const limitations: string[] = [];

  // ------------------------------------------------------------ lookup tables
  const jvmFqn = new Map<string, string>(); // com.x.Foo -> path ; com.x.topLevelFn -> path
  const jvmPkgFiles = new Map<string, string[]>();
  const goDirFiles = new Map<string, string[]>();
  const pyModules = new Map<string, string>();
  const resources = new Map<string, string[]>(); // layout/foo -> [paths]
  const basenameIdx = new Map<string, string[]>();
  for (const p of parsed) {
    const { path } = p.file;
    const b = basename(path);
    basenameIdx.set(b, [...(basenameIdx.get(b) ?? []), path]);
    const lang = p.record.language;
    if ((lang === 'kotlin' || lang === 'java') && p.parse.pkg !== undefined) {
      const pkg = p.parse.pkg;
      jvmPkgFiles.set(pkg, [...(jvmPkgFiles.get(pkg) ?? []), path]);
      for (const s of p.parse.symbols) {
        if (!s.container) jvmFqn.set(`${pkg}.${s.name}`, path);
        else if (!s.container.includes('.')) jvmFqn.set(`${pkg}.${s.container}.${s.name}`, path);
      }
      // Kotlin file facade (FooKt) and file-name class for Java.
      const stem = b.replace(/\.(kt|java)$/, '');
      if (!jvmFqn.has(`${pkg}.${stem}`)) jvmFqn.set(`${pkg}.${stem}`, path);
    } else if ((lang === 'kotlin' || lang === 'java') && p.record.role !== 'build') {
      const stem = b.replace(/\.(kt|java)$/, '');
      jvmFqn.set(stem, path);
    }
    if (lang === 'go') {
      const d = dirname(path);
      goDirFiles.set(d, [...(goDirFiles.get(d) ?? []), path]);
    }
    if (lang === 'python') {
      const noExt = path.replace(/\.pyi?$/, '');
      const variants = [noExt];
      for (const prefix of ['src/', 'lib/', 'app/']) if (noExt.startsWith(prefix)) variants.push(noExt.slice(prefix.length));
      for (const v of variants) {
        const mod = v.replace(/\/__init__$/, '').split('/').join('.');
        if (mod && !pyModules.has(mod)) pyModules.set(mod, path);
      }
    }
    const res = /(?:^|\/)res\/([a-z]+)(?:-[\w-]+)?\/([\w.]+)\.\w+$/.exec(path);
    if (res) {
      const type = res[1]!;
      const name = res[2]!.replace(/\.9$/, '');
      if (type === 'values') {
        for (const m of p.file.content.matchAll(/<(string|color|dimen|style|integer|bool|array|string-array|integer-array|plurals|attr|declare-styleable)\b[^>]*\bname\s*=\s*"([\w.]+)"/g)) {
          const t = m[1]!.endsWith('-array') ? 'array' : m[1]!;
          const key = `${t}/${m[2]!.replace(/\./g, '_')}`;
          resources.set(key, [...(resources.get(key) ?? []), path]);
        }
      } else {
        const key = `${type}/${name}`;
        resources.set(key, [...(resources.get(key) ?? []), path]);
      }
    }
  }
  const internalJvmRoots = new Set([...jvmPkgFiles.keys()].map((pkg) => pkg.split('.').slice(0, 2).join('.')));
  const internalPyRoots = new Set([...pyModules.keys()].map((m) => m.split('.')[0]!));

  // Go module path
  const goModFile = parsed.find((p) => basename(p.file.path) === 'go.mod');
  const goModule = goModFile?.parse.build?.name;
  const goModRoot = goModFile ? dirname(goModFile.file.path) : '';

  // npm workspace packages: name -> dir
  const npmPackages = new Map<string, string>();
  for (const p of parsed) if (basename(p.file.path) === 'package.json' && p.parse.build?.name) npmPackages.set(p.parse.build.name, dirname(p.file.path));

  // Gradle modules
  const settings = parsed.find((p) => /(^|\/)settings\.gradle(\.kts)?$/.test(p.file.path) && p.parse.build?.includes);
  const gradleModules = new Map<string, string>(); // :app -> app
  if (settings) {
    const base = dirname(settings.file.path);
    for (const inc of settings.parse.build!.includes!) {
      const dir = joinPath(base, inc.slice(1).split(':').join('/'));
      if (dir !== null) gradleModules.set(inc, dir);
    }
  }
  for (const p of parsed) {
    if (!/(^|\/)build\.gradle(\.kts)?$/.test(p.file.path)) continue;
    const dir = dirname(p.file.path);
    if (dir && ![...gradleModules.values()].includes(dir)) gradleModules.set(`:${dir.split('/').join(':')}`, dir);
  }
  const moduleOfPath = (path: string): string | undefined => {
    let best: string | undefined;
    let bestLen = -1;
    for (const [id, dir] of gradleModules) {
      if ((dir === '' || path.startsWith(`${dir}/`)) && dir.length > bestLen) {
        best = id;
        bestLen = dir.length;
      }
    }
    return best;
  };

  // ------------------------------------------------------------ import resolution
  const edges: GraphEdge[] = [];
  const edgeKeys = new Set<string>();
  const addEdge = (from: string, to: string, kind: GraphEdge['kind']) => {
    if (from === to) return;
    const key = `${from}\u0000${to}\u0000${kind}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ from, to, kind });
  };
  let unresolvedCount = 0;

  const resolveTs = (from: string, spec: string): ResolvedImport['target'] | null | 'external' => {
    let base: string | null = null;
    if (spec.startsWith('.')) base = joinPath(dirname(from), spec);
    else if (spec.startsWith('@/') || spec.startsWith('~/')) base = joinPath('src', spec.slice(2));
    else {
      const parts = spec.split('/');
      const pkgName = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
      const dir = npmPackages.get(pkgName);
      if (dir === undefined) return 'external';
      const sub = parts.slice(spec.startsWith('@') ? 2 : 1).join('/');
      base = joinPath(dir, sub || 'src/index');
      if (base !== null && !sub) {
        const pj = byPath.get(dir ? `${dir}/package.json` : 'package.json');
        const main = pj?.parse.build?.entry?.find((e) => e.kind === 'package-main')?.detail;
        const candidates = [main && joinPath(dir, main), joinPath(dir, 'src/index'), joinPath(dir, 'index')].filter(Boolean) as string[];
        for (const c of candidates) {
          const hit = tryTs(c);
          if (hit) return hit;
        }
        return null;
      }
    }
    if (base === null) return null;
    return tryTs(base);
  };
  const tryTs = (base: string): string | undefined => {
    if (paths.has(base)) return base;
    const noJs = base.replace(/\.(m|c)?js$/, '');
    for (const ext of TS_EXTS) if (paths.has(noJs + ext)) return noJs + ext;
    for (const ext of TS_EXTS) if (paths.has(`${base}/index${ext}`)) return `${base}/index${ext}`;
    return undefined;
  };

  for (const p of parsed) {
    const from = p.file.path;
    const lang = p.record.language;
    const resolved: ResolvedImport[] = [];
    for (const imp of p.parse.imports) {
      const r: ResolvedImport = { ...imp, external: false };
      if (lang === 'typescript' || lang === 'javascript') {
        const t = resolveTs(from, imp.spec);
        if (t === 'external') r.external = true;
        else if (t) r.target = t;
        else r.unresolved = true;
      } else if (lang === 'kotlin' || lang === 'java' || lang === 'xml' || lang === 'android-manifest') {
        if (imp.kind === 'resource') {
          r.external = false;
        } else if (imp.spec.endsWith('.*')) {
          const pkg = imp.spec.slice(0, -2);
          const filesInPkg = jvmPkgFiles.get(pkg);
          if (filesInPkg) {
            r.target = filesInPkg[0];
            filesInPkg.slice(0, 25).forEach((t) => addEdge(from, t, 'import'));
          } else r.external = !internalJvmRoots.has(pkg.split('.').slice(0, 2).join('.'));
          if (!filesInPkg && !r.external) r.unresolved = true;
        } else {
          let target = jvmFqn.get(imp.spec);
          if (!target) {
            // Nested class or member import: try progressively shorter prefixes.
            const segs = imp.spec.split('.');
            for (let k = segs.length - 1; k >= 2 && !target; k--) target = jvmFqn.get(segs.slice(0, k).join('.'));
          }
          if (target) r.target = target;
          else if (internalJvmRoots.has(imp.spec.split('.').slice(0, 2).join('.')) && !/\.R$|\.BuildConfig$|\.databinding\./.test(imp.spec)) r.unresolved = true;
          else r.external = true;
        }
      } else if (lang === 'python') {
        let mod = imp.spec;
        if (mod.startsWith('.')) {
          const dots = /^\.+/.exec(mod)![0].length;
          const pkgParts = dirname(from).split('/').filter(Boolean);
          const baseParts = pkgParts.slice(0, Math.max(0, pkgParts.length - (dots - 1)));
          const rest = mod.slice(dots);
          const candidate = [...baseParts, ...(rest ? rest.split('.') : [])].join('/');
          const tries = [`${candidate}.py`, `${candidate}/__init__.py`, ...(imp.names ?? []).map((n) => `${candidate}/${n}.py`)];
          const hit = tries.find((t) => paths.has(t));
          if (hit) {
            r.target = hit;
            for (const t of tries.slice(2)) if (paths.has(t)) addEdge(from, t, 'import');
          } else r.unresolved = true;
        } else {
          let target = pyModules.get(mod);
          for (const n of imp.names ?? []) {
            const sub = pyModules.get(`${mod}.${n}`);
            if (sub) {
              addEdge(from, sub, 'import');
              target ??= sub;
            }
          }
          while (!target && mod.includes('.')) {
            mod = mod.slice(0, mod.lastIndexOf('.'));
            target = pyModules.get(mod);
          }
          if (target) r.target = target;
          else if (internalPyRoots.has(imp.spec.split('.')[0]!)) r.unresolved = true;
          else r.external = true;
        }
      } else if (lang === 'rust') {
        const d = dirname(from);
        const isModRoot = /(^|\/)(mod|lib|main)\.rs$/.test(from) || /(^|\/)src\/bin\/[^/]+\.rs$/.test(from);
        const modDir = isModRoot ? d : joinPath(d, basename(from).replace(/\.rs$/, ''))!;
        if (imp.kind === 'mod') {
          const cands = [`${modDir ? modDir + '/' : ''}${imp.spec}.rs`, `${modDir ? modDir + '/' : ''}${imp.spec}/mod.rs`];
          const hit = cands.find((c) => paths.has(c));
          if (hit) r.target = hit;
          else r.unresolved = true;
        } else {
          const segs = imp.spec.replace(/\{.*$/, '').split('::').filter(Boolean);
          let baseDir: string | null = null;
          if (segs[0] === 'crate') {
            const srcIdx = from.lastIndexOf('src/');
            baseDir = srcIdx >= 0 ? from.slice(0, srcIdx + 3) : '';
            segs.shift();
          } else if (segs[0] === 'super') {
            baseDir = dirname(isModRoot ? d : modDir);
            segs.shift();
          } else if (segs[0] === 'self') {
            baseDir = modDir;
            segs.shift();
          }
          if (baseDir === null) r.external = true;
          else {
            let hit: string | undefined;
            for (let k = segs.length; k >= 1 && !hit; k--) {
              const rel = segs.slice(0, k).join('/');
              const prefix = baseDir ? `${baseDir}/` : '';
              hit = [`${prefix}${rel}.rs`, `${prefix}${rel}/mod.rs`].find((c) => paths.has(c));
            }
            if (hit) r.target = hit;
            else r.unresolved = true;
          }
        }
      } else if (lang === 'go') {
        if (goModule && (imp.spec === goModule || imp.spec.startsWith(`${goModule}/`))) {
          const rel = imp.spec.slice(goModule.length).replace(/^\//, '');
          const dir = joinPath(goModRoot, rel) ?? '';
          const filesInDir = (goDirFiles.get(dir) ?? []).filter((f) => !f.endsWith('_test.go'));
          if (filesInDir.length) {
            r.target = filesInDir[0];
            filesInDir.slice(0, 25).forEach((t) => addEdge(from, t, 'import'));
          } else r.unresolved = true;
        } else r.external = true;
      } else if (lang === 'c' || lang === 'cpp') {
        if (imp.spec.startsWith('<')) r.external = true;
        else {
          const rel = joinPath(dirname(from), imp.spec);
          if (rel && paths.has(rel)) r.target = rel;
          else {
            const cands = (basenameIdx.get(basename(imp.spec)) ?? []).filter((c) => c.endsWith(imp.spec));
            if (cands.length) r.target = cands[0];
            else r.external = true; // could be a system / third-party header
          }
        }
      } else if (imp.kind === 'gradle-project') {
        const dir = gradleModules.get(imp.spec);
        if (dir !== undefined) {
          const bf = [`${dir}/build.gradle.kts`, `${dir}/build.gradle`].find((c) => paths.has(c));
          if (bf) {
            r.target = bf;
            addEdge(from, bf, 'module');
          }
        }
        if (!r.target) r.unresolved = true;
      } else {
        r.external = true;
      }
      if (r.target && imp.kind !== 'gradle-project') addEdge(from, r.target, lang === 'c' || lang === 'cpp' ? 'include' : 'import');
      if (r.unresolved) unresolvedCount++;
      resolved.push(r);
    }
    for (const ref of p.parse.resourceRefs) {
      for (const t of resources.get(ref) ?? []) addEdge(from, t, 'resource');
    }
    p.record.imports = resolved;
    p.record.module = moduleOfPath(from);
  }

  // Implicit same-package references (Kotlin/Java/Go need no import within a package).
  const identCache = new Map<string, Set<string>>();
  const identsOf = (path: string): Set<string> => {
    let s = identCache.get(path);
    if (!s) {
      s = new Set(byPath.get(path)!.file.content.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);
      identCache.set(path, s);
    }
    return s;
  };
  const samePackageGroups: string[][] = [...jvmPkgFiles.values(), ...[...goDirFiles.values()]];
  for (const group of samePackageGroups) {
    if (group.length < 2 || group.length > 400) continue;
    const exportsByFile = group.map((path) => ({
      path,
      names: byPath.get(path)!.parse.symbols.filter((s) => !s.container && s.name.length > 2).map((s) => s.name)
    }));
    for (const a of group) {
      const ids = identsOf(a);
      for (const b of exportsByFile) {
        if (b.path === a) continue;
        if (b.names.some((n) => ids.has(n))) addEdge(a, b.path, 'import');
      }
    }
  }

  // Test -> subject edges by naming convention.
  for (const p of parsed) {
    if (p.record.role !== 'test') continue;
    const b = basename(p.file.path);
    const subjectNames = [
      b.replace(/(Test|Tests|IT|Spec)\.(kt|java)$/, '.$2'),
      b.replace(/\.(test|spec)\.([cm]?[jt]sx?)$/, '.$2'),
      b.replace(/^test_(.+\.py)$/, '$1'),
      b.replace(/_test\.(py|go)$/, '.$1')
    ].filter((n) => n !== b);
    for (const name of subjectNames) {
      for (const cand of basenameIdx.get(name) ?? []) if (!isTestPath(cand)) addEdge(p.file.path, cand, 'test');
    }
  }

  // ------------------------------------------------------------ modules
  const modules: ModuleInfo[] = [];
  const catalogFile = parsed.find((p) => p.parse.build?.catalog);
  const catalog = catalogFile?.parse.build?.catalog;
  for (const [id, dir] of gradleModules) {
    const bf = [`${dir ? dir + '/' : ''}build.gradle.kts`, `${dir ? dir + '/' : ''}build.gradle`].find((c) => paths.has(c));
    const b = bf ? byPath.get(bf)?.parse.build : undefined;
    const fileCount = parsed.filter((p) => p.record.module === id).length;
    const plugins = (b?.plugins ?? []).map((pl) => (pl.startsWith('catalog:') && catalog ? catalog[`plugins.${pl.slice(8)}`]?.split(':')[0] ?? pl : pl));
    const isApp = plugins.some((pl) => /com\.android\.application|android\.application/.test(pl));
    const isLib = plugins.some((pl) => /com\.android\.library|android\.library/.test(pl));
    const manifest = [`${dir ? dir + '/' : ''}src/main/AndroidManifest.xml`].find((c) => paths.has(c));
    modules.push({
      id,
      kind: 'gradle',
      root: dir,
      buildFile: bf,
      dependsOn: b?.projectDeps ?? [],
      externalDeps: [...(b?.deps ?? []), ...(b?.catalogDeps ?? []).map((a) => (catalog?.[a] ? `${catalog[a]} (libs.${a})` : `libs.${a}`))],
      fileCount,
      android: isApp || isLib ? { type: isApp ? 'application' : 'library', namespace: b?.android?.namespace, manifest } : undefined
    });
  }
  for (const p of parsed) {
    const b = basename(p.file.path);
    const dir = dirname(p.file.path);
    const build = p.parse.build;
    if (!build) continue;
    if (b === 'package.json' && build.name) {
      modules.push({
        id: build.name,
        kind: 'npm',
        root: dir,
        buildFile: p.file.path,
        dependsOn: build.projectDeps.filter((d) => npmPackages.has(d)),
        externalDeps: build.deps,
        fileCount: parsed.filter((q) => (dir === '' ? true : q.file.path.startsWith(`${dir}/`))).length
      });
    } else if (b === 'Cargo.toml' && build.name) {
      modules.push({ id: build.name, kind: 'cargo', root: dir, buildFile: p.file.path, dependsOn: build.projectDeps, externalDeps: build.deps, fileCount: parsed.filter((q) => dir === '' || q.file.path.startsWith(`${dir}/`)).length });
    } else if (b === 'go.mod' && build.name) {
      modules.push({ id: build.name, kind: 'go', root: dir, buildFile: p.file.path, dependsOn: [], externalDeps: build.deps, fileCount: parsed.filter((q) => q.record.language === 'go').length });
    } else if (b === 'pyproject.toml' && build.name) {
      modules.push({ id: build.name, kind: 'python', root: dir, buildFile: p.file.path, dependsOn: [], externalDeps: build.deps, fileCount: parsed.filter((q) => q.record.language === 'python').length });
    }
  }
  if (modules.length === 0) {
    // Fallback: top-level directories as modules, dependencies derived from file edges.
    const top = (path: string) => (path.includes('/') ? path.split('/')[0]! : '(root)');
    const groups = new Map<string, number>();
    for (const p of parsed) groups.set(top(p.file.path), (groups.get(top(p.file.path)) ?? 0) + 1);
    const deps = new Map<string, Set<string>>();
    for (const e of edges) {
      const a = top(e.from);
      const b = top(e.to);
      if (a !== b) deps.set(a, (deps.get(a) ?? new Set()).add(b));
    }
    for (const [id, count] of groups) modules.push({ id, kind: 'directory', root: id === '(root)' ? '' : id, dependsOn: [...(deps.get(id) ?? [])], externalDeps: [], fileCount: count });
  }

  // ------------------------------------------------------------ entry points
  const entryPoints: EntryPoint[] = [];
  for (const p of parsed) {
    const build = p.parse.build;
    if (p.record.language === 'android-manifest' && build?.components) {
      const mod = modules.find((m) => m.android?.manifest === p.file.path);
      const ns = build.manifestPackage ?? mod?.android?.namespace;
      for (const c of build.components) {
        const fqn = c.name.startsWith('.') && ns ? ns + c.name : !c.name.includes('.') && ns ? `${ns}.${c.name}` : c.name;
        const target = jvmFqn.get(fqn) ?? p.file.path;
        if (target !== p.file.path) addEdge(p.file.path, target, 'import');
        const kind: EntryPoint['kind'] =
          c.kind === 'activity' ? (c.launcher ? 'android-launcher-activity' : 'android-activity') : c.kind === 'application' ? 'android-application' : (`android-${c.kind}` as EntryPoint['kind']);
        entryPoints.push({ path: target, kind, detail: fqn });
      }
    }
    if (build?.entry) {
      const dir = dirname(p.file.path);
      for (const e of build.entry) {
        const t = joinPath(dir, e.detail.replace(/^\.\//, ''));
        entryPoints.push({ path: t && paths.has(t) ? t : p.file.path, kind: e.kind, detail: e.detail });
      }
    }
    if (p.parse.hasMain) {
      entryPoints.push({ path: p.file.path, kind: p.record.language === 'python' ? 'python-main' : 'main-function', detail: `main in ${basename(p.file.path)}` });
    }
    if (/(^|\/)index\.html$/.test(p.file.path) && !p.file.path.includes('/test')) entryPoints.push({ path: p.file.path, kind: 'web-index', detail: 'HTML entry' });
  }

  // ------------------------------------------------------------ config map
  const config: ConfigEntry[] = [];
  for (const p of parsed) {
    const entry = describeConfig(p.file.path, p.parse.build);
    if (entry) config.push(entry);
  }

  // ------------------------------------------------------------ symbol index & stats
  const symbolIndex: RepoIndex['symbolIndex'] = {};
  const stats: RepoStats = {
    fileCount: files.length + skipped.length,
    indexedFiles: files.length,
    skippedFiles: skipped.length,
    totalBytes: 0,
    totalLines: 0,
    byLanguage: {},
    byRole: {}
  };
  const fileRecords: Record<string, FileRecord> = {};
  for (const p of parsed) {
    const r = p.record;
    fileRecords[r.path] = r;
    stats.totalBytes += r.size;
    stats.totalLines += r.lines;
    const l = (stats.byLanguage[r.language] ??= { files: 0, lines: 0, bytes: 0 });
    l.files++;
    l.lines += r.lines;
    l.bytes += r.size;
    stats.byRole[r.role] = (stats.byRole[r.role] ?? 0) + 1;
    if (r.language === 'markdown') continue;
    for (const s of r.symbols) {
      (symbolIndex[s.name] ??= []).push({ path: r.path, line: s.line, kind: s.kind });
    }
  }

  // ------------------------------------------------------------ limitations
  const lexical = parsed.filter((p) => p.record.fidelity === 'lexical').length;
  if (lexical > 0) {
    limitations.push(
      `${lexical} source files were parsed with lexical (regex + brace/indent tracking) extractors, not full ASTs. Symbols declared via macros, code generation, unusual formatting or reflection may be missed.`
    );
  }
  if (unresolvedCount > 0) limitations.push(`${unresolvedCount} internal-looking imports could not be resolved to a file; dependency edges for them are missing.`);
  const skippedBy = skipped.reduce<Record<string, number>>((acc, s) => ((acc[s.reason] = (acc[s.reason] ?? 0) + 1), acc), {});
  for (const [reason, count] of Object.entries(skippedBy)) limitations.push(`${count} files skipped (${reason}).`);
  if (skippedBy['limit']) limitations.push('The file limit was reached; the index is INCOMPLETE. Increase the limit or add exclusions.');
  if (parsed.some((p) => p.record.language === 'kotlin' || p.record.language === 'java')) {
    limitations.push('Generated code (ViewBinding, Room, Hilt/Dagger, KSP/KAPT output, BuildConfig, R) is not indexed because it does not exist in the source tree.');
  }
  if (parsed.some((p) => p.record.language === 'typescript')) limitations.push('tsconfig `paths` aliases other than `@/` and `~/` are not resolved.');
  const parserErrors = parsed.filter((p) => p.record.notes.some((n) => n.startsWith('Parser error')));
  if (parserErrors.length) limitations.push(`${parserErrors.length} files failed to parse (see file notes).`);

  return {
    version: INDEX_VERSION,
    createdAt: new Date().toISOString(),
    files: fileRecords,
    edges,
    modules,
    entryPoints,
    config,
    symbolIndex,
    stats,
    skipped,
    stack: detectStack(parsed, catalog),
    limitations,
    versionCatalog: catalog
  };
}

function describeConfig(path: string, build: BuildInfo | undefined): ConfigEntry | null {
  const b = basename(path);
  const ext = extname(path);
  if (/^settings\.gradle(\.kts)?$/.test(b)) return { path, kind: 'gradle-settings', summary: `Gradle settings${build?.rootName ? ` (${build.rootName})` : ''}: ${build?.includes?.join(', ') ?? 'no includes'}` };
  if (/^build\.gradle(\.kts)?$/.test(b)) {
    const a = build?.android;
    const bits = [
      build?.plugins.length ? `plugins: ${build.plugins.slice(0, 6).join(', ')}` : '',
      a?.namespace ? `namespace ${a.namespace}` : '',
      a?.minSdk ? `minSdk ${a.minSdk}` : '',
      a?.targetSdk ? `targetSdk ${a.targetSdk}` : '',
      build ? `${build.deps.length + build.catalogDeps.length} deps, ${build.projectDeps.length} project deps` : ''
    ].filter(Boolean);
    return { path, kind: 'gradle-build', summary: bits.join('; ') || 'Gradle build script' };
  }
  if (b.endsWith('.versions.toml')) return { path, kind: 'version-catalog', summary: `Version catalog with ${Object.keys(build?.catalog ?? {}).length} entries` };
  if (b === 'AndroidManifest.xml') return { path, kind: 'android-manifest', summary: `${build?.components?.length ?? 0} components, ${build?.permissions?.length ?? 0} permissions` };
  if (b === 'package.json') return { path, kind: 'package-json', summary: `${build?.name ?? 'package'}: ${build?.deps.length ?? 0} deps, scripts: ${Object.keys(build?.scripts ?? {}).join(', ') || 'none'}` };
  if (/^tsconfig.*\.json$/.test(b)) return { path, kind: 'tsconfig', summary: 'TypeScript compiler configuration' };
  if (b === 'Cargo.toml') return { path, kind: 'cargo', summary: `Crate ${build?.name ?? '(workspace)'}: ${build?.deps.length ?? 0} deps` };
  if (b === 'go.mod') return { path, kind: 'go-mod', summary: `Go module ${build?.name ?? ''}` };
  if (b === 'pyproject.toml' || b === 'setup.py' || b === 'setup.cfg' || /^requirements.*\.txt$/.test(b)) return { path, kind: 'python-project', summary: `Python project config (${build?.deps.length ?? 0} deps)` };
  if (path.startsWith('.github/workflows/') || b === '.gitlab-ci.yml' || b === 'Jenkinsfile') return { path, kind: 'ci', summary: 'CI pipeline' };
  if (/^(\.eslintrc.*|eslint\.config\.\w+|\.prettierrc.*|detekt\.ya?ml|\.editorconfig|ruff\.toml|\.flake8|clippy\.toml|lint\.xml)$/.test(b)) return { path, kind: 'lint', summary: 'Lint / formatting rules' };
  if (b === '.env.example' || b === '.env.sample') return { path, kind: 'env', summary: 'Environment variable template' };
  if (ext === 'properties') return { path, kind: 'properties', summary: 'Properties file' };
  if (b === 'Dockerfile' || /^docker-compose\.ya?ml$/.test(b)) return { path, kind: 'docker', summary: 'Container configuration' };
  if (b === 'pom.xml' || b === 'Makefile' || b === 'CMakeLists.txt') return { path, kind: 'other', summary: `${b} build configuration` };
  return null;
}

function detectStack(parsed: Parsed[], catalog: Record<string, string> | undefined): string[] {
  const facts: string[] = [];
  const langs = new Map<string, number>();
  for (const p of parsed) if (p.record.role === 'source' || p.record.role === 'test') langs.set(p.record.language, (langs.get(p.record.language) ?? 0) + p.record.lines);
  const totalLines = [...langs.values()].reduce((a, b) => a + b, 0) || 1;
  for (const [l, n] of [...langs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) facts.push(`${l}: ${Math.round((n / totalLines) * 100)}% of source lines`);
  const allDeps = parsed.flatMap((p) => [...(p.parse.build?.deps ?? []), ...(p.parse.build?.catalogDeps ?? []).map((a) => catalog?.[a] ?? a), ...(p.parse.build?.plugins ?? [])]).join('\n') + '\n' + Object.values(catalog ?? {}).join('\n');
  const has = (re: RegExp) => re.test(allDeps);
  const checks: [RegExp, string][] = [
    [/com\.android\.application|android\.application/, 'Android application (Android Gradle Plugin)'],
    [/com\.android\.library|android\.library/, 'Android library modules'],
    [/compose|androidx\.compose/, 'Jetpack Compose'],
    [/androidx\.room/, 'Room (SQLite persistence)'],
    [/hilt|dagger/, 'Hilt / Dagger dependency injection'],
    [/koin/, 'Koin dependency injection'],
    [/retrofit/, 'Retrofit HTTP client'],
    [/ktor/, 'Ktor'],
    [/kotlinx-coroutines|kotlinx\.coroutines/, 'Kotlin Coroutines'],
    [/navigation/, 'AndroidX Navigation'],
    [/datastore/, 'AndroidX DataStore'],
    [/junit/i, 'JUnit tests'],
    [/espresso/, 'Espresso UI tests'],
    [/mockk|mockito/, 'MockK / Mockito'],
    [/^react@|\nreact@/, 'React'],
    [/^next@|\nnext@/, 'Next.js'],
    [/^vue@|\nvue@/, 'Vue'],
    [/^svelte@|\nsvelte@/, 'Svelte'],
    [/^express@|\nexpress@/, 'Express'],
    [/^vite@|\nvite@/, 'Vite'],
    [/^vitest@|\nvitest@/, 'Vitest'],
    [/^jest@|\njest@/, 'Jest'],
    [/^typescript@|\ntypescript@/, 'TypeScript compiler'],
    [/django/i, 'Django'],
    [/flask/i, 'Flask'],
    [/fastapi/i, 'FastAPI'],
    [/pytest/, 'pytest'],
    [/\btokio\b/, 'Tokio async runtime'],
    [/\bserde\b/, 'Serde'],
    [/\bclap\b/, 'Clap CLI']
  ];
  for (const [re, label] of checks) if (has(re)) facts.push(label);
  if (parsed.some((p) => p.parse.symbols.some((s) => s.kind === 'composable')) && !facts.includes('Jetpack Compose')) facts.push('Jetpack Compose (detected from @Composable functions)');
  if (parsed.some((p) => /(^|\/)res\/layout\//.test(p.file.path))) facts.push('Android XML layouts');
  if (parsed.some((p) => basename(p.file.path) === 'gradlew')) facts.push('Gradle wrapper present');
  return facts;
}
