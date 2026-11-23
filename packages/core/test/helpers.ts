import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PathFilter, buildIndex, type RepoIndex, type SkippedFile, type SourceFile } from '@repomind/core';

export const FIXTURES = fileURLToPath(new URL('../../../benchmarks/fixtures/', import.meta.url));

/** Mimics the engine's directory scan for fixture repositories. */
export function loadFixture(name: string): { files: SourceFile[]; skipped: SkippedFile[] } {
  const root = join(FIXTURES, name);
  const filter = new PathFilter();
  const files: SourceFile[] = [];
  const skipped: SkippedFile[] = [];
  const walk = (dir: string) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    const gi = entries.find((e) => e.name === '.gitignore');
    if (gi) filter.addGitignore(relative(root, dir).split('\\').join('/'), readFileSync(join(dir, gi.name), 'utf8'));
    for (const e of entries) {
      const abs = join(dir, e.name);
      const rel = relative(root, abs).split('\\').join('/');
      if (e.isDirectory()) {
        if (filter.isIgnored(rel, true)) continue;
        walk(abs);
      } else {
        const size = statSync(abs).size;
        const reason = filter.check(rel, size);
        if (reason) skipped.push({ path: rel, reason });
        else files.push({ path: rel, content: readFileSync(abs, 'utf8'), size });
      }
    }
  };
  walk(root);
  return { files, skipped };
}

const cache = new Map<string, { files: SourceFile[]; index: RepoIndex; contents: Map<string, string> }>();
export function indexed(name: string) {
  let hit = cache.get(name);
  if (!hit) {
    const { files, skipped } = loadFixture(name);
    hit = { files, index: buildIndex(files, skipped), contents: new Map(files.map((f) => [f.path, f.content])) };
    cache.set(name, hit);
  }
  return hit;
}

export function memoryRepo(files: Record<string, string>) {
  const list: SourceFile[] = Object.entries(files).map(([path, content]) => ({ path, content, size: content.length }));
  return { files: list, index: buildIndex(list), contents: new Map(list.map((f) => [f.path, f.content])) };
}
