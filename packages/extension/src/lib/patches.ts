import { diffTexts, extractChanges, formatUnifiedDiff, parseUnifiedDiff, type FilePatch } from '@repomind/core';
import type { ActiveData } from './store';

/**
 * Converts a pasted DeepSeek response into one unified diff.
 * - ```diff blocks are parsed (counts repaired) and kept.
 * - Whole-file blocks (`FILE: path` + code fence) are diffed against the indexed content.
 */
export function responseToDiff(response: string, active: ActiveData): { diff: string; notes: string[]; files: number } {
  const changes = extractChanges(response);
  const files: FilePatch[] = [];
  const notes: string[] = [];
  for (const c of changes) {
    if (c.kind === 'diff') {
      const p = parseUnifiedDiff(c.content);
      files.push(...p.files);
      for (const i of p.issues) notes.push(`${i.severity}: ${i.path ? `${i.path}: ` : ''}${i.message}`);
    } else if (c.path) {
      const before = active.contents.get(c.path) ?? null;
      if (before === c.content) {
        notes.push(`info: ${c.path}: full-file block is identical to the current file (no change).`);
        continue;
      }
      if (before === null) notes.push(`info: ${c.path}: treated as a NEW file (not in the index).`);
      else notes.push(`info: ${c.path}: full-file block converted to a diff against the indexed version.`);
      files.push(diffTexts(c.path, before, c.content));
    }
  }
  if (!changes.length) notes.push('error: No diff or file block found in the response.');
  // Merge multiple sections for the same file is not attempted: report duplicates.
  const seen = new Set<string>();
  for (const f of files) {
    if (seen.has(f.path)) notes.push(`warning: ${f.path} appears more than once; review carefully.`);
    seen.add(f.path);
  }
  return { diff: files.length ? formatUnifiedDiff(files) : '', notes, files: files.length };
}
