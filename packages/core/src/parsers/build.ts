import { LineMap, scanSource } from './scan.js';
import { emptyResult, uniq, type BuildInfo, type ParseResult } from './util.js';
import type { ImportRef } from '../types.js';

function newBuild(): BuildInfo {
  return { plugins: [], deps: [], projectDeps: [], catalogDeps: [] };
}

// ---------------------------------------------------------------- Gradle (Groovy + Kotlin DSL)

const GRADLE_CONFIGS =
  'implementation|api|kapt|ksp|compileOnly|runtimeOnly|testImplementation|androidTestImplementation|debugImplementation|releaseImplementation|testRuntimeOnly|annotationProcessor|coreLibraryDesugaring|lintChecks|detektPlugins|classpath';

export function parseGradle(src: string): ParseResult {
  const { noComments } = scanSource(src, { comments: 'c', singleQuoteStrings: true, tripleQuotes: true });
  const lm = new LineMap(src);
  const b = newBuild();
  const imports: ImportRef[] = [];

  for (const m of noComments.matchAll(/\bid\s*\(?\s*["']([\w.-]+)["']\s*\)?/g)) b.plugins.push(m[1]!);
  for (const m of noComments.matchAll(/\bkotlin\s*\(\s*["']([\w.-]+)["']\s*\)/g)) b.plugins.push(`org.jetbrains.kotlin.${m[1]}`);
  for (const m of noComments.matchAll(/\balias\s*\(\s*libs\.plugins\.([\w.]+)\s*\)/g)) b.plugins.push(`catalog:${m[1]}`);
  for (const m of noComments.matchAll(/apply\s+plugin\s*:\s*["']([\w.-]+)["']/g)) b.plugins.push(m[1]!);

  const depRe = new RegExp(`\\b(${GRADLE_CONFIGS})\\s*\\(?\\s*(platform\\s*\\(\\s*)?(project\\s*\\(\\s*(?:path\\s*[:=]\\s*)?["']([^"']+)["']|projects\\.([\\w.]+)|["']([^"'$]+)["']|libs\\.([\\w.]+)|files\\s*\\()`, 'g');
  for (const m of noComments.matchAll(depRe)) {
    if (m[4]) {
      b.projectDeps.push(m[4]);
      imports.push({ spec: m[4], line: lm.lineAt(m.index!), kind: 'gradle-project' });
    } else if (m[5]) {
      // Type-safe project accessors: projects.core.data -> :core:data (kebab names are camelCased by Gradle).
      const path = ':' + m[5].split('.').map((s) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)).join(':');
      b.projectDeps.push(path);
      imports.push({ spec: path, line: lm.lineAt(m.index!), kind: 'gradle-project' });
    } else if (m[6]) b.deps.push(m[6]);
    else if (m[7]) {
      const alias = m[7].replace(/\.get\(\)$/, '');
      if (alias !== 'bundles' && !alias.startsWith('versions.')) b.catalogDeps.push(alias);
    }
  }
  const android: NonNullable<BuildInfo['android']> = {};
  const str = (key: string) => new RegExp(`\\b${key}\\s*=?\\s*["']([^"']+)["']`).exec(noComments)?.[1];
  const num = (key: string) => new RegExp(`\\b${key}(?:Version)?\\s*=?\\s*\\(?\\s*(\\d+|libs\\.versions\\.[\\w.]+)`).exec(noComments)?.[1];
  android.namespace = str('namespace');
  android.applicationId = str('applicationId');
  android.compileSdk = num('compileSdk');
  android.minSdk = num('minSdk');
  android.targetSdk = num('targetSdk');
  if (Object.values(android).some(Boolean)) b.android = android;

  // settings.gradle(.kts)
  const includes: string[] = [];
  for (const m of noComments.matchAll(/\binclude\s*\(?([^\n)]*)\)?/g)) {
    for (const s of m[1]!.matchAll(/["'](:?[\w.:-]+)["']/g)) includes.push(s[1]!.startsWith(':') ? s[1]! : `:${s[1]}`);
  }
  if (includes.length) b.includes = uniq(includes);
  const rootName = /rootProject\.name\s*=\s*["']([^"']+)["']/.exec(noComments)?.[1];
  if (rootName) b.rootName = rootName;
  b.plugins = uniq(b.plugins);
  b.deps = uniq(b.deps);
  b.projectDeps = uniq(b.projectDeps);
  b.catalogDeps = uniq(b.catalogDeps);
  return { ...emptyResult('lexical'), imports, build: b };
}

// ---------------------------------------------------------------- Minimal TOML (version catalogs, Cargo, pyproject)

export type TomlTable = Record<string, string | string[] | Record<string, string>>;

/** Tolerant TOML subset: sections, `key = "str"`, `key = [ "a", "b" ]` (multi-line), `key = { a = "b" }`. */
export function parseTomlSubset(src: string): Record<string, TomlTable> {
  const out: Record<string, TomlTable> = { '': {} };
  let section = '';
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const sec = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(line);
    if (sec) {
      section = sec[1]!;
      if (/^\[\[/.test(line)) {
        let k = 0;
        while (out[`${section}#${k}`]) k++;
        section = `${section}#${k}`;
      }
      out[section] ??= {};
      continue;
    }
    const kv = /^("?[\w.-]+"?)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!.replace(/"/g, '');
    let val = kv[2]!;
    if (val.startsWith('[') && !val.includes(']')) {
      while (i + 1 < lines.length && !val.includes(']')) val += ' ' + lines[++i]!.replace(/\s+#.*$/, '').trim();
    }
    if (val.startsWith('{') && !val.includes('}')) {
      while (i + 1 < lines.length && !val.includes('}')) val += ' ' + lines[++i]!.trim();
    }
    const table = out[section]!;
    if (val.startsWith('"') || val.startsWith("'")) table[key] = val.slice(1, val.indexOf(val[0]!, 1));
    else if (val.startsWith('[')) table[key] = [...val.matchAll(/["']([^"']*)["']/g)].map((m) => m[1]!);
    else if (val.startsWith('{')) {
      const obj: Record<string, string> = {};
      for (const m of val.matchAll(/([\w.-]+)\s*=\s*(?:["']([^"']*)["']|([\w.-]+))/g)) obj[m[1]!] = m[2] ?? m[3]!;
      table[key] = obj;
    } else table[key] = val;
  }
  return out;
}

export function parseVersionCatalog(src: string): ParseResult {
  const toml = parseTomlSubset(src);
  const versions = toml['versions'] ?? {};
  const catalog: Record<string, string> = {};
  const norm = (alias: string) => alias.replace(/[-_]/g, '.');
  const versionOf = (v: Record<string, string>) => v['version.ref'] ? String(versions[v['version.ref']] ?? v['version.ref']) : v['version'] ?? '';
  for (const [alias, v] of Object.entries(toml['libraries'] ?? {})) {
    if (typeof v === 'string') catalog[norm(alias)] = v;
    else if (!Array.isArray(v)) {
      const module = v['module'] ?? (v['group'] && v['name'] ? `${v['group']}:${v['name']}` : '');
      const ver = versionOf(v);
      catalog[norm(alias)] = ver ? `${module}:${ver}` : module;
    }
  }
  for (const [alias, v] of Object.entries(toml['plugins'] ?? {})) {
    if (typeof v === 'string') catalog[`plugins.${norm(alias)}`] = v;
    else if (!Array.isArray(v)) catalog[`plugins.${norm(alias)}`] = `${v['id'] ?? ''}${versionOf(v) ? `:${versionOf(v)}` : ''}`;
  }
  const b = newBuild();
  b.catalog = catalog;
  return { ...emptyResult('structural'), build: b };
}

// ---------------------------------------------------------------- Android

function attr(tag: string, name: string): string | undefined {
  return new RegExp(`(?:android:)?${name}\\s*=\\s*"([^"]*)"`).exec(tag)?.[1];
}

export function parseAndroidManifest(src: string): ParseResult {
  const { noComments } = scanSource(src, { comments: 'xml', singleQuoteStrings: true });
  const b = newBuild();
  b.manifestPackage = /<manifest\b[^>]*\bpackage\s*=\s*"([^"]+)"/.exec(noComments)?.[1];
  b.components = [];
  b.permissions = [...noComments.matchAll(/<uses-permission\b[^>]*android:name\s*=\s*"([^"]+)"/g)].map((m) => m[1]!);
  const app = /<application\b([^>]*)>/.exec(noComments);
  if (app) {
    const name = attr(app[1]!, 'android:name') ?? attr(app[1]!, 'name');
    if (name) b.components.push({ kind: 'application', name, launcher: false });
  }
  for (const m of noComments.matchAll(/<(activity|activity-alias|service|receiver|provider)\b([^>]*?)(\/>|>)/g)) {
    const tag = m[1]!;
    const name = attr(m[2]!, 'android:name');
    if (!name) continue;
    let launcher = false;
    if (m[3] === '>') {
      const close = noComments.indexOf(`</${tag}>`, m.index!);
      const body = noComments.slice(m.index!, close < 0 ? undefined : close);
      launcher = /android\.intent\.action\.MAIN/.test(body) && /android\.intent\.category\.LAUNCHER/.test(body);
    }
    const kind = tag.startsWith('activity') ? 'activity' : (tag as 'service' | 'receiver' | 'provider');
    b.components.push({ kind, name, launcher });
  }
  const imports: ImportRef[] = [];
  const lm = new LineMap(src);
  for (const m of noComments.matchAll(/@(layout|drawable|mipmap|xml|navigation|menu|string|style|color)\/([\w.]+)/g)) {
    imports.push({ spec: `${m[1]}/${m[2]}`, line: lm.lineAt(m.index!), kind: 'resource' });
  }
  return { ...emptyResult('structural'), build: b, imports, resourceRefs: uniq(imports.map((i) => i.spec)) };
}

/** Layout / navigation / menu XML: resource references and custom view / fragment class references. */
export function parseAndroidXml(src: string): ParseResult {
  const { noComments } = scanSource(src, { comments: 'xml', singleQuoteStrings: true });
  const lm = new LineMap(src);
  const imports: ImportRef[] = [];
  const refs: string[] = [];
  for (const m of noComments.matchAll(/@\+?(layout|drawable|mipmap|xml|navigation|menu|string|style|color|dimen|anim|font|raw|array)\/([\w.]+)/g)) {
    refs.push(`${m[1]}/${m[2]}`);
  }
  for (const m of noComments.matchAll(/<([a-z][\w]*(?:\.[\w]+){2,})[\s/>]/g)) {
    imports.push({ spec: m[1]!, line: lm.lineAt(m.index!), kind: 'import' });
  }
  for (const m of noComments.matchAll(/(?:android:name|tools:context|class)\s*=\s*"([\w.]+)"/g)) {
    if (m[1]!.includes('.')) imports.push({ spec: m[1]!, line: lm.lineAt(m.index!), kind: 'import' });
  }
  return { ...emptyResult('structural'), imports, resourceRefs: uniq(refs) };
}

// ---------------------------------------------------------------- Ecosystem manifests

export function parsePackageJson(src: string): ParseResult {
  const r = emptyResult('structural');
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(src) as Record<string, unknown>;
  } catch {
    r.notes.push('package.json is not valid JSON.');
    r.fidelity = 'none';
    return r;
  }
  const b = newBuild();
  b.name = typeof json['name'] === 'string' ? json['name'] : undefined;
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = json[key];
    if (deps && typeof deps === 'object') for (const [n, v] of Object.entries(deps as Record<string, string>)) {
      if (typeof v === 'string' && (v.startsWith('workspace:') || v.startsWith('file:'))) b.projectDeps.push(n);
      else b.deps.push(`${n}@${String(v)}`);
    }
  }
  const scripts = json['scripts'];
  if (scripts && typeof scripts === 'object') b.scripts = Object.fromEntries(Object.entries(scripts as Record<string, unknown>).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
  b.entry = [];
  for (const key of ['main', 'module', 'browser']) if (typeof json[key] === 'string') b.entry.push({ kind: 'package-main', detail: json[key] as string });
  const bin = json['bin'];
  if (typeof bin === 'string') b.entry.push({ kind: 'package-bin', detail: bin });
  else if (bin && typeof bin === 'object') for (const v of Object.values(bin as Record<string, string>)) b.entry.push({ kind: 'package-bin', detail: v });
  const ws = json['workspaces'];
  if (Array.isArray(ws)) b.workspaces = ws.filter((x): x is string => typeof x === 'string');
  else if (ws && typeof ws === 'object' && Array.isArray((ws as { packages?: unknown }).packages)) b.workspaces = (ws as { packages: string[] }).packages;
  r.build = b;
  return r;
}

export function parseCargoToml(src: string): ParseResult {
  const t = parseTomlSubset(src);
  const b = newBuild();
  b.name = t['package']?.['name'] as string | undefined;
  for (const sec of ['dependencies', 'dev-dependencies', 'build-dependencies']) {
    for (const [n, v] of Object.entries(t[sec] ?? {})) {
      if (typeof v === 'object' && !Array.isArray(v) && v['path']) b.projectDeps.push(n);
      else b.deps.push(n);
    }
  }
  const members = t['workspace']?.['members'];
  if (Array.isArray(members)) b.workspaces = members;
  b.entry = Object.keys(t)
    .filter((k) => k.startsWith('bin#'))
    .map((k) => ({ kind: 'package-bin' as const, detail: String(t[k]!['path'] ?? t[k]!['name'] ?? '') }));
  return { ...emptyResult('structural'), build: b };
}

export function parseGoMod(src: string): ParseResult {
  const b = newBuild();
  b.name = /^module\s+(\S+)/m.exec(src)?.[1];
  for (const m of src.matchAll(/^\s*(?:require\s+)?([\w.-]+\.[\w./-]+)\s+(v[\w.+-]+)/gm)) b.deps.push(`${m[1]}@${m[2]}`);
  return { ...emptyResult('structural'), build: b };
}

export function parsePyProject(src: string): ParseResult {
  const t = parseTomlSubset(src);
  const b = newBuild();
  b.name = (t['project']?.['name'] ?? t['tool.poetry']?.['name']) as string | undefined;
  const deps = t['project']?.['dependencies'];
  if (Array.isArray(deps)) b.deps.push(...deps);
  for (const n of Object.keys(t['tool.poetry.dependencies'] ?? {})) if (n !== 'python') b.deps.push(n);
  const scripts = t['project.scripts'];
  if (scripts) b.scripts = Object.fromEntries(Object.entries(scripts).map(([k, v]) => [k, String(v)]));
  b.plugins = Object.keys(t).filter((k) => k.startsWith('tool.')).map((k) => k.split('.')[1]!);
  b.plugins = uniq(b.plugins);
  return { ...emptyResult('structural'), build: b };
}

export function parseRequirements(src: string): ParseResult {
  const b = newBuild();
  for (const line of src.split('\n')) {
    const t = line.replace(/#.*/, '').trim();
    if (t && !t.startsWith('-')) b.deps.push(t);
  }
  return { ...emptyResult('structural'), build: b };
}

export function parseMarkdown(src: string): ParseResult {
  const r = emptyResult('structural');
  const lines = src.split('\n');
  let inFence = false;
  lines.forEach((l, i) => {
    if (/^\s*```/.test(l)) inFence = !inFence;
    if (inFence) return;
    const h = /^(#{1,3})\s+(.+)$/.exec(l);
    if (h) r.symbols.push({ name: h[2]!.trim().slice(0, 120), kind: 'module', line: i + 1, exported: true, signature: l.trim() });
  });
  return r;
}
