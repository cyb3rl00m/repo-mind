/**
 * Core data model shared by the extension and the local engine.
 * Everything here must be JSON-serializable (stored in IndexedDB and sent over Native Messaging).
 */

export type Language =
  | 'kotlin'
  | 'java'
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'rust'
  | 'go'
  | 'c'
  | 'cpp'
  | 'gradle'
  | 'gradle-kts'
  | 'xml'
  | 'android-manifest'
  | 'toml'
  | 'json'
  | 'yaml'
  | 'markdown'
  | 'properties'
  | 'sql'
  | 'shell'
  | 'html'
  | 'css'
  | 'text'
  | 'unknown';

export type FileRole = 'source' | 'test' | 'config' | 'build' | 'docs' | 'resource' | 'manifest' | 'schema' | 'other';

/** A text file as ingested from GitHub, the local engine or a browser folder handle. */
export interface SourceFile {
  /** Repository-relative POSIX path, never absolute, never containing `..`. */
  path: string;
  content: string;
  size: number;
}

export interface SkippedFile {
  path: string;
  reason: 'ignored' | 'binary' | 'too-large' | 'secret-file' | 'excluded' | 'limit' | 'unreadable';
}

/** Parser fidelity — surfaced in the UI so users know how far to trust extracted structure. */
export type ParseFidelity = 'structural' | 'lexical' | 'none';

export type SymbolKind =
  | 'class'
  | 'interface'
  | 'object'
  | 'enum'
  | 'record'
  | 'struct'
  | 'trait'
  | 'type'
  | 'function'
  | 'method'
  | 'constant'
  | 'variable'
  | 'module'
  | 'composable'
  | 'activity'
  | 'fragment'
  | 'viewmodel'
  | 'entity'
  | 'dao';

export interface SymbolInfo {
  name: string;
  kind: SymbolKind;
  /** 1-based line number. */
  line: number;
  exported: boolean;
  /** Trimmed declaration line(s), used for signature diffing and outlines. */
  signature: string;
  /** Declared return type when the parser could find one. */
  returnType?: string;
  /** Containing class/object for methods. */
  container?: string;
  /** Annotations/decorators directly attached (e.g. @Entity, @Composable). */
  annotations?: string[];
}

export interface ImportRef {
  /** Raw specifier as written (`./foo`, `com.example.Foo`, `crate::a::b`, `<stdio.h>`). */
  spec: string;
  line: number;
  /** Imported names when known. */
  names?: string[];
  kind: 'import' | 'require' | 'include' | 'use' | 'mod' | 'dynamic' | 'reexport' | 'resource' | 'gradle-project';
}

export interface ResolvedImport extends ImportRef {
  /** Repository path the import resolved to, if internal. */
  target?: string;
  /** True when the specifier looks like a third-party / stdlib package. */
  external: boolean;
  /** True when it looked internal (relative, same package root) but could not be resolved. */
  unresolved?: boolean;
}

export interface FileRecord {
  path: string;
  language: Language;
  role: FileRole;
  size: number;
  lines: number;
  tokensEstimate: number;
  fidelity: ParseFidelity;
  /** Package / namespace declared in the file (Kotlin/Java/Go). */
  pkg?: string;
  symbols: SymbolInfo[];
  imports: ResolvedImport[];
  /** Android resource references like `R.layout.activity_main` -> `layout/activity_main`. */
  resourceRefs: string[];
  /** Gradle module that owns the file, e.g. `:app`. */
  module?: string;
  secretFindings: SecretFinding[];
  injectionFindings: InjectionFinding[];
  /** Parser limitations specific to this file. */
  notes: string[];
}

export interface SecretFinding {
  type: string;
  line: number;
  /** Redacted preview — never the secret itself. */
  preview: string;
}

export interface InjectionFinding {
  line: number;
  phrase: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: 'import' | 'resource' | 'module' | 'test' | 'include';
}

export interface ModuleInfo {
  /** Module id: Gradle path (`:app`), npm workspace name, cargo crate, go module, or top-level dir. */
  id: string;
  kind: 'gradle' | 'npm' | 'cargo' | 'go' | 'python' | 'directory';
  root: string;
  buildFile?: string;
  /** Module ids this module depends on. */
  dependsOn: string[];
  /** External dependency coordinates declared by the module. */
  externalDeps: string[];
  fileCount: number;
  android?: { type: 'application' | 'library'; namespace?: string; manifest?: string };
}

export interface EntryPoint {
  path: string;
  kind:
    | 'android-launcher-activity'
    | 'android-activity'
    | 'android-service'
    | 'android-receiver'
    | 'android-provider'
    | 'android-application'
    | 'main-function'
    | 'package-main'
    | 'package-bin'
    | 'cli-script'
    | 'web-index'
    | 'python-main';
  detail: string;
}

export interface ConfigEntry {
  path: string;
  kind:
    | 'gradle-settings'
    | 'gradle-build'
    | 'version-catalog'
    | 'android-manifest'
    | 'package-json'
    | 'tsconfig'
    | 'cargo'
    | 'go-mod'
    | 'python-project'
    | 'ci'
    | 'lint'
    | 'env'
    | 'properties'
    | 'docker'
    | 'other';
  summary: string;
}

export interface RepoStats {
  fileCount: number;
  indexedFiles: number;
  skippedFiles: number;
  totalBytes: number;
  totalLines: number;
  byLanguage: Record<string, { files: number; lines: number; bytes: number }>;
  byRole: Record<string, number>;
}

export interface RepoIndex {
  version: number;
  createdAt: string;
  files: Record<string, FileRecord>;
  edges: GraphEdge[];
  modules: ModuleInfo[];
  entryPoints: EntryPoint[];
  config: ConfigEntry[];
  /** symbol name -> list of `path#line` */
  symbolIndex: Record<string, { path: string; line: number; kind: SymbolKind }[]>;
  stats: RepoStats;
  skipped: SkippedFile[];
  /** Human-readable technical stack facts detected from manifests. */
  stack: string[];
  /** Known limitations of this index (unresolved imports, heuristic parsers, truncation). */
  limitations: string[];
  /** Version catalog aliases -> coordinates (Android). */
  versionCatalog?: Record<string, string>;
}

export interface RepoIdentity {
  name: string;
  source: 'github' | 'local-engine' | 'local-browser';
  owner?: string;
  repo?: string;
  branch?: string;
  commit?: string;
  path?: string;
  dirty?: boolean;
}
