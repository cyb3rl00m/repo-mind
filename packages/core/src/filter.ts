import ignoreFactory from 'ignore';
import { DEFAULT_EXCLUSIONS, hasBinaryExtension, dirname } from './lang.js';
import { isSecretFile } from './secrets.js';
import type { SkippedFile } from './types.js';

export interface IngestOptions {
  /** Extra gitignore-style patterns from Settings. */
  extraExclusions?: string[];
  /** Disable built-in defaults (not recommended). */
  useDefaultExclusions?: boolean;
  /** Respect .gitignore files found in the tree. Default true. */
  respectGitignore?: boolean;
  /** Max bytes per file (default 768 KiB). */
  maxFileBytes?: number;
  /** Max number of indexed files (default 25 000). */
  maxFiles?: number;
  /** Include secret files (default false — strongly discouraged). */
  includeSecretFiles?: boolean;
}

export const DEFAULT_INGEST: Required<IngestOptions> = {
  extraExclusions: [],
  useDefaultExclusions: true,
  respectGitignore: true,
  maxFileBytes: 768 * 1024,
  maxFiles: 25_000,
  includeSecretFiles: false
};

type Ignore = ReturnType<typeof ignoreFactory>;

/**
 * Path filter that combines default exclusions, user exclusions and nested .gitignore files.
 * Nested .gitignore rules are applied relative to the directory that contains them.
 */
export class PathFilter {
  private readonly base: Ignore;
  private readonly nested = new Map<string, Ignore>();
  readonly options: Required<IngestOptions>;

  constructor(options: IngestOptions = {}) {
    this.options = { ...DEFAULT_INGEST, ...options };
    this.base = ignoreFactory({ allowRelativePaths: true });
    if (this.options.useDefaultExclusions) this.base.add(DEFAULT_EXCLUSIONS);
    if (this.options.extraExclusions.length) this.base.add(this.options.extraExclusions);
  }

  addGitignore(dir: string, content: string): void {
    if (!this.options.respectGitignore) return;
    const lines = content
      .split('\n')
      .map((l) => l.replace(/\r$/, ''))
      .filter((l) => l.trim() !== '' && !l.startsWith('#'));
    if (lines.length === 0) return;
    const ig = ignoreFactory({ allowRelativePaths: true }).add(lines);
    this.nested.set(dir, ig);
  }

  /** `isDir` makes directory-only patterns (`build/`) match the directory itself. */
  isIgnored(path: string, isDir = false): boolean {
    const p = isDir ? `${path}/` : path;
    if (this.base.ignores(p)) return true;
    for (const [dir, ig] of this.nested) {
      if (dir === '') {
        if (ig.ignores(p)) return true;
      } else if (p.startsWith(`${dir}/`)) {
        const rel = p.slice(dir.length + 1);
        if (rel && ig.ignores(rel)) return true;
      }
    }
    return false;
  }

  /** Decides whether a file should be read. Returns a skip reason or null when the file is accepted. */
  check(path: string, size: number): SkippedFile['reason'] | null {
    if (this.isIgnored(path)) return 'ignored';
    if (!this.options.includeSecretFiles && isSecretFile(path)) return 'secret-file';
    if (hasBinaryExtension(path)) return 'binary';
    if (size > this.options.maxFileBytes) return 'too-large';
    return null;
  }
}

/** Collects all .gitignore files from a flat path list (for zip / pre-listed sources). */
export function gitignoreDirs(paths: string[]): string[] {
  return paths.filter((p) => p === '.gitignore' || p.endsWith('/.gitignore')).map((p) => dirname(p));
}
