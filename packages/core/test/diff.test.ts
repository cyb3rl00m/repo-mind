import { describe, expect, it } from 'vitest';
import { analyzeRegression, applyFilePatch, diffTexts, extractChanges, formatUnifiedDiff, parseUnifiedDiff, validatePatchPaths } from '@repomind/core';
import { indexed } from './helpers.js';

const GIT_DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 line1
-line2
+line2 changed
+line2b
 line3
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+export const x = 1;
+export const y = 2;
diff --git a/old.txt b/old.txt
deleted file mode 100644
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
`;

describe('unified diff parsing', () => {
  it('parses modified, added and deleted files', () => {
    const p = parseUnifiedDiff(GIT_DIFF);
    expect(p.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
    expect(p.files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ['src/a.ts', 'modified', 2, 1],
      ['src/new.ts', 'added', 2, 0],
      ['old.txt', 'deleted', 0, 1]
    ]);
  });

  it('recomputes wrong hunk counts (common in LLM output) and warns', () => {
    const p = parseUnifiedDiff('--- a/f.txt\n+++ b/f.txt\n@@ -1,9 +1,9 @@\n a\n-b\n+c\n d\n');
    expect(p.files[0]!.hunks[0]).toMatchObject({ oldLines: 3, newLines: 3, recounted: true });
    expect(p.issues.some((i) => i.severity === 'warning' && /recomputed/.test(i.message))).toBe(true);
  });

  it('tolerates blank context lines without the leading space', () => {
    const p = parseUnifiedDiff('--- a/f.txt\n+++ b/f.txt\n@@ -1,3 +1,3 @@\n a\n\n-b\n+c\n');
    expect(p.files[0]!.hunks[0]!.lines.map((l) => l.type).join('')).toBe('  -+');
  });

  it('reports missing diffs and binary patches', () => {
    expect(parseUnifiedDiff('just text').issues[0]!.severity).toBe('error');
    const bin = parseUnifiedDiff('diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n');
    expect(bin.issues.some((i) => /Binary/.test(i.message))).toBe(true);
  });

  it('round-trips through the formatter', () => {
    const p = parseUnifiedDiff(GIT_DIFF);
    const again = parseUnifiedDiff(formatUnifiedDiff(p));
    expect(again.files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual(p.files.map((f) => [f.path, f.status, f.additions, f.deletions]));
  });
});

describe('in-memory patch application', () => {
  it('applies with offsets and reports fuzz', () => {
    const original = 'header\nextra\nline1\nline2\nline3\n';
    const p = parseUnifiedDiff(GIT_DIFF).files[0]!;
    const r = applyFilePatch(original, p);
    expect(r.ok).toBe(true);
    expect(r.content).toBe('header\nextra\nline1\nline2 changed\nline2b\nline3\n');
    expect(r.fuzzy[0]!.offset).toBe(2);
  });
  it('fails cleanly when context is missing', () => {
    const r = applyFilePatch('totally\ndifferent\n', parseUnifiedDiff(GIT_DIFF).files[0]!);
    expect(r.ok).toBe(false);
    expect(r.failed[0]!.reason).toMatch(/not found/);
  });
  it('diffTexts + apply round-trip on realistic content', () => {
    const a = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n') + '\n';
    const lines = a.split('\n');
    lines[10] = 'changed 10';
    lines.splice(100, 3);
    lines.splice(150, 0, 'inserted A', 'inserted B');
    const b = lines.join('\n');
    const fp = diffTexts('f.txt', a, b);
    expect(fp.hunks.length).toBeGreaterThanOrEqual(3);
    expect(applyFilePatch(a, fp).content).toBe(b);
    const reparsed = parseUnifiedDiff(formatUnifiedDiff([fp])).files[0]!;
    expect(applyFilePatch(a, reparsed).content).toBe(b);
  });
  it('handles new and deleted files', () => {
    expect(applyFilePatch(null, diffTexts('n.txt', null, 'x\ny\n')).content).toBe('x\ny\n');
    expect(applyFilePatch('x\n', diffTexts('n.txt', 'x\n', null)).content).toBeNull();
  });
});

describe('extracting changes from DeepSeek responses', () => {
  it('finds fenced diffs and whole-file blocks with path hints', () => {
    const resp = [
      'Here is the change:',
      '```diff',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      '```',
      '',
      'FILE: src/util/helpers.ts',
      '```typescript',
      'export const h = 1;',
      '```',
      '```kotlin',
      '// app/src/main/java/com/x/Foo.kt',
      'class Foo',
      '```',
      '```bash',
      'echo not a file',
      '```'
    ].join('\n');
    const ch = extractChanges(resp);
    expect(ch.map((c) => [c.kind, c.path ?? ''])).toEqual([
      ['diff', ''],
      ['file', 'src/util/helpers.ts'],
      ['file', 'app/src/main/java/com/x/Foo.kt']
    ]);
    expect(ch[2]!.content).toBe('class Foo\n');
  });
  it('detects bare diffs without fences', () => {
    const ch = extractChanges('Sure!\ndiff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n');
    expect(ch).toHaveLength(1);
    expect(ch[0]!.kind).toBe('diff');
  });
});

describe('patch path validation', () => {
  const known = new Set(['src/a.ts', 'old.txt']);
  it('blocks traversal, absolute paths, git internals and secret files', () => {
    const p = parseUnifiedDiff('--- a/../etc/passwd\n+++ b/../etc/passwd\n@@ -1 +1 @@\n-a\n+b\n--- /etc/hosts\n+++ /etc/hosts\n@@ -1 +1 @@\n-a\n+b\n--- a/.git/config\n+++ b/.git/config\n@@ -1 +1 @@\n-a\n+b\n--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n-a\n+b\n');
    const issues = validatePatchPaths(p, { knownFiles: known });
    const msgs = issues.filter((i) => i.severity === 'error').map((i) => i.message).join('\n');
    expect(msgs).toMatch(/escapes the repository/);
    expect(msgs).toMatch(/Absolute path/);
    expect(msgs).toMatch(/git internals/);
    expect(msgs).toMatch(/secret/);
  });
  it('requires explicit permission for deletions', () => {
    const p = parseUnifiedDiff(GIT_DIFF);
    expect(validatePatchPaths(p, { knownFiles: known }).some((i) => i.severity === 'error' && /deletes/.test(i.message))).toBe(true);
    expect(validatePatchPaths(p, { knownFiles: known, allowDeletes: true }).some((i) => i.severity === 'error')).toBe(false);
  });
});

describe('regression prevention engine', () => {
  const { index, contents } = indexed('android-notes');
  const repo = 'core/data/src/main/java/com/example/notes/data/NoteRepository.kt';
  const note = 'core/data/src/main/java/com/example/notes/data/Note.kt';

  const patchFor = (path: string, mutate: (s: string) => string) => {
    const before = contents.get(path)!;
    return formatUnifiedDiff([diffTexts(path, before, mutate(before))]);
  };

  it('flags removed functions that are still used elsewhere', () => {
    const diff = patchFor(repo, (s) => s.replace(/\n {4}suspend fun setArchived[^\n]*\n/, '\n'));
    const r = analyzeRegression(parseUnifiedDiff(diff), index, contents);
    const f = r.findings.find((x) => x.category === 'removed-symbol');
    expect(f?.severity).toBe('high');
    expect(f?.explanation).toMatch(/NotesViewModel\.kt/);
    expect(r.summary.verdict).toBe('review-carefully');
  });

  it('flags changed signatures and return types', () => {
    const diff = patchFor(repo, (s) => s.replace('suspend fun add(text: String): Long', 'suspend fun add(text: String, pinned: Boolean): Unit'));
    const r = analyzeRegression(parseUnifiedDiff(diff), index, contents);
    expect(r.findings.some((f) => f.category === 'signature' && f.severity === 'high')).toBe(true);
    expect(r.findings.some((f) => f.category === 'return-type')).toBe(true);
  });

  it('flags entity changes without a migration', () => {
    const diff = patchFor(note, (s) => s.replace('val archived: Boolean = false,', 'val archived: Boolean = false,\n    @ColumnInfo(name = "pinned") val pinned: Boolean = false,'));
    const r = analyzeRegression(parseUnifiedDiff(diff), index, contents);
    const schema = r.findings.filter((f) => f.category === 'schema');
    expect(schema.length).toBeGreaterThan(0);
    expect(schema.some((f) => /No migration/.test(f.explanation))).toBe(true);
    expect(r.checklist.join('\n')).toMatch(/upgrade install/);
  });

  it('flags elided-code placeholders, broken imports, unrelated files and destructive ops', () => {
    const vm = 'app/src/main/java/com/example/notes/ui/NotesViewModel.kt';
    const d1 = patchFor(vm, (s) => s.replace('import kotlinx.coroutines.launch', 'import kotlinx.coroutines.launch\nimport com.example.notes.data.PinnedNotesStore').replace('    fun toggleArchived', '    // ... rest of the existing code ...\n    fun toggleArchived'));
    const d2 = patchFor('core/data/src/main/java/com/example/notes/data/NotesDatabase.kt', (s) => s.replace('.build()', '.fallbackToDestructiveMigration().build()'));
    const r = analyzeRegression(parseUnifiedDiff(d1 + d2), index, contents, { expectedFiles: [vm] });
    const cats = new Set(r.findings.map((f) => f.category));
    expect([...cats]).toEqual(expect.arrayContaining(['placeholder', 'import', 'destructive', 'unrelated']));
    expect(r.findings.find((f) => f.category === 'import')?.title).toMatch(/PinnedNotesStore/);
  });

  it('marks patches that do not apply as blocked', () => {
    const diff = `--- a/${repo}\n+++ b/${repo}\n@@ -1,2 +1,2 @@\n-this line does not exist\n+x\n context\n`;
    const r = analyzeRegression(parseUnifiedDiff(diff), index, contents);
    expect(r.summary.verdict).toBe('blocked');
  });

  it('builds a checklist with tests to run', () => {
    const diff = patchFor('app/src/main/java/com/example/notes/ui/NotesViewModel.kt', (s) => s.replace('if (trimmed.isEmpty()) return', 'if (trimmed.isBlank()) return'));
    const r = analyzeRegression(parseUnifiedDiff(diff), index, contents);
    expect(r.checklist.join('\n')).toMatch(/NotesViewModelTest/);
    expect(r.checklist.join('\n')).toMatch(/:app/);
    expect(r.summary.high).toBe(0);
  });
});
