import type { FileRole, Language } from './types.js';

const EXT_LANG: Record<string, Language> = {
  kt: 'kotlin',
  kts: 'kotlin',
  java: 'java',
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  pyi: 'python',
  rs: 'rust',
  go: 'go',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  hxx: 'cpp',
  xml: 'xml',
  toml: 'toml',
  json: 'json',
  jsonc: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  md: 'markdown',
  mdx: 'markdown',
  markdown: 'markdown',
  properties: 'properties',
  sql: 'sql',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  fish: 'shell',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'css',
  txt: 'text',
  gradle: 'gradle',
  pro: 'text',
  cfg: 'text',
  ini: 'text',
  env: 'text'
};

export function extname(path: string): string {
  const base = basename(path);
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1).toLowerCase() : '';
}

export function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(0, i) : '';
}

export function detectLanguage(path: string): Language {
  const base = basename(path);
  if (base === 'AndroidManifest.xml') return 'android-manifest';
  if (base.endsWith('.gradle.kts')) return 'gradle-kts';
  if (base === 'Dockerfile' || base === 'Makefile' || base === 'CMakeLists.txt') return 'text';
  if (base === 'gradlew') return 'shell';
  return EXT_LANG[extname(path)] ?? 'unknown';
}

const TEST_PATTERNS: RegExp[] = [
  /(^|\/)(test|tests|__tests__|spec|specs|androidTest|testDebug|testRelease|integrationTest)\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /(^|\/)test_[^/]+\.py$/,
  /_test\.(py|go)$/,
  /(Test|Tests|IT|Spec)\.(kt|java)$/,
  /(^|\/)tests\/[^/]+\.rs$/
];

export function isTestPath(path: string): boolean {
  return TEST_PATTERNS.some((re) => re.test(path));
}

const CONFIG_BASENAMES = new Set([
  'package.json',
  'tsconfig.json',
  'jsconfig.json',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'requirements.txt',
  'gradle.properties',
  'local.properties',
  'settings.gradle',
  'settings.gradle.kts',
  'build.gradle',
  'build.gradle.kts',
  'libs.versions.toml',
  'pom.xml',
  'Dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'Makefile',
  'CMakeLists.txt',
  'vite.config.ts',
  'vite.config.js',
  'webpack.config.js',
  'eslint.config.js',
  '.eslintrc.json',
  '.eslintrc.js',
  'proguard-rules.pro',
  'gradle-wrapper.properties'
]);

export function detectRole(path: string, language: Language): FileRole {
  const base = basename(path);
  if (isTestPath(path)) return 'test';
  if (language === 'android-manifest') return 'manifest';
  if (language === 'gradle' || language === 'gradle-kts' || base === 'pom.xml' || base === 'Makefile' || base === 'CMakeLists.txt') {
    return 'build';
  }
  if (CONFIG_BASENAMES.has(base) || path.startsWith('.github/') || base.startsWith('.')) return 'config';
  if (language === 'markdown' || /^(docs?|documentation)\//i.test(path)) return 'docs';
  if (language === 'sql' || /(^|\/)(migrations?|schemas?)\//.test(path) || base.endsWith('.prisma')) return 'schema';
  if (/(^|\/)res\/(layout|values|drawable|menu|navigation|xml|raw|anim|color|mipmap|font)[^/]*\//.test(path)) return 'resource';
  if (['kotlin', 'java', 'typescript', 'javascript', 'python', 'rust', 'go', 'c', 'cpp', 'shell'].includes(language)) return 'source';
  if (['json', 'yaml', 'toml', 'properties', 'xml'].includes(language)) return 'config';
  return 'other';
}

/** Default exclusion patterns (gitignore syntax). Users can extend these in Settings. */
export const DEFAULT_EXCLUSIONS: string[] = [
  '.git/',
  'node_modules/',
  'bower_components/',
  'dist/',
  'build/',
  'out/',
  'target/',
  '.gradle/',
  '.idea/',
  '.vscode/',
  '.cxx/',
  '.externalNativeBuild/',
  'captures/',
  '.kotlin/',
  '__pycache__/',
  '.pytest_cache/',
  '.mypy_cache/',
  '.ruff_cache/',
  '.venv/',
  'venv/',
  '.tox/',
  '.next/',
  '.nuxt/',
  '.svelte-kit/',
  '.turbo/',
  '.cache/',
  'coverage/',
  'vendor/',
  'Pods/',
  'DerivedData/',
  '*.min.js',
  '*.min.css',
  '*.map',
  '*.lock',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'Cargo.lock',
  'go.sum',
  'poetry.lock',
  'gradle/wrapper/gradle-wrapper.jar'
];

const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'icns', 'svgz', 'tif', 'tiff', 'avif', 'heic',
  'mp3', 'mp4', 'wav', 'ogg', 'flac', 'm4a', 'mov', 'avi', 'mkv', 'webm',
  'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'tar', 'zst',
  'jar', 'aar', 'apk', 'aab', 'dex', 'class', 'so', 'dylib', 'dll', 'exe', 'o', 'a', 'lib', 'obj', 'bin', 'wasm',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt',
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  'keystore', 'jks', 'p12', 'pfx', 'der',
  'db', 'sqlite', 'sqlite3', 'realm',
  'pyc', 'pyo', 'node', 'pdb', 'idx', 'pack'
]);

export function hasBinaryExtension(path: string): boolean {
  return BINARY_EXTENSIONS.has(extname(path));
}

/** Detects binary content by NUL bytes / high ratio of control characters in the first 8 KiB. */
export function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192);
  if (n === 0) return false;
  let suspicious = 0;
  for (let i = 0; i < n; i++) {
    const b = bytes[i]!;
    if (b === 0) return true;
    if (b < 7 || (b > 13 && b < 32)) suspicious++;
  }
  return suspicious / n > 0.1;
}

const decoder = new TextDecoder('utf-8', { fatal: false });
export function decodeText(bytes: Uint8Array): string {
  let text = decoder.decode(bytes);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.replace(/\r\n/g, '\n');
}

/** Normalizes a repository-relative path. Returns null when the path is unsafe. */
export function normalizeRepoPath(raw: string): string | null {
  if (!raw || raw.includes('\0')) return null;
  let p = raw.replace(/\\/g, '/');
  if (p.startsWith('/') || /^[a-zA-Z]:\//.test(p) || p.startsWith('~')) return null;
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return null;
    parts.push(seg);
  }
  p = parts.join('/');
  return p.length > 0 ? p : null;
}
