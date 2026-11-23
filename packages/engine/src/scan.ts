import { lstatSync, openSync, readSync, closeSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { PathFilter, decodeText, looksBinary, type IngestOptions, type SkippedFile, type SourceFile } from '@repomind/core';
import { isInside } from './projects.js';

export interface ScanResult {
  files: SourceFile[];
  skipped: SkippedFile[];
}

/**
 * Walks a project directory. Respects nested .gitignore files and RepoMind exclusions, never
 * follows directory symlinks, and only reads file symlinks that stay inside the project.
 */
export function scanProject(root: string, options: IngestOptions = {}, onProgress?: (n: number) => void): ScanResult {
  const filter = new PathFilter(options);
  const files: SourceFile[] = [];
  const skipped: SkippedFile[] = [];
  let seen = 0;

  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      skipped.push({ path: relative(root, dir).split(sep).join('/') || '.', reason: 'unreadable' });
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const relDir = relative(root, dir).split(sep).join('/');
    const gi = entries.find((e) => e.name === '.gitignore' && e.isFile());
    if (gi) {
      try {
        filter.addGitignore(relDir, readFileSync(join(dir, gi.name), 'utf8'));
      } catch {
        /* unreadable .gitignore */
      }
    }
    for (const e of entries) {
      const abs = join(dir, e.name);
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (filter.isIgnored(rel, true)) continue;
        walk(abs);
        continue;
      }
      if (e.isSymbolicLink()) {
        let real: string;
        try {
          real = realpathSync(abs);
        } catch {
          skipped.push({ path: rel, reason: 'unreadable' });
          continue;
        }
        if (!isInside(root, real) || !statSync(real).isFile()) {
          skipped.push({ path: rel, reason: 'excluded' });
          continue;
        }
      } else if (!e.isFile()) continue;
      seen++;
      if (onProgress && seen % 500 === 0) onProgress(seen);
      let size: number;
      try {
        size = lstatSync(abs).isSymbolicLink() ? statSync(abs).size : lstatSync(abs).size;
      } catch {
        skipped.push({ path: rel, reason: 'unreadable' });
        continue;
      }
      const reason = filter.check(rel, size);
      if (reason) {
        skipped.push({ path: rel, reason });
        continue;
      }
      if (files.length >= filter.options.maxFiles) {
        skipped.push({ path: rel, reason: 'limit' });
        continue;
      }
      try {
        const head = Buffer.alloc(Math.min(size, 8192));
        const fd = openSync(abs, 'r');
        try {
          readSync(fd, head, 0, head.length, 0);
        } finally {
          closeSync(fd);
        }
        if (looksBinary(head)) {
          skipped.push({ path: rel, reason: 'binary' });
          continue;
        }
        files.push({ path: rel, content: decodeText(readFileSync(abs)), size });
      } catch {
        skipped.push({ path: rel, reason: 'unreadable' });
      }
    }
  };
  walk(root);
  return { files, skipped };
}
