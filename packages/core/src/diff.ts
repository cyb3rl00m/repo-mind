import { normalizeRepoPath } from './lang.js';
import { isSecretFile } from './secrets.js';

export interface HunkLine {
  type: ' ' | '+' | '-';
  text: string;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  section: string;
  lines: HunkLine[];
  /** Header counts disagreed with the body and were recomputed. */
  recounted?: boolean;
}

export type FileStatus = 'modified' | 'added' | 'deleted' | 'renamed';

export interface FilePatch {
  oldPath: string | null;
  newPath: string | null;
  status: FileStatus;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  binary: boolean;
  /** Path the change applies to (new path, or old path for deletions). */
  path: string;
}

export interface PatchIssue {
  severity: 'error' | 'warning';
  path?: string;
  line?: number;
  message: string;
}

export interface ParsedPatch {
  files: FilePatch[];
  issues: PatchIssue[];
}

function stripPrefix(p: string): string | null {
  let s = p.trim();
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
  if (s === '/dev/null') return null;
  if (/^[ab]\//.test(s)) s = s.slice(2);
  return s;
}

/** Parses a unified diff (git or plain). Lenient by design: problems are reported as issues, not thrown. */
export function parseUnifiedDiff(text: string): ParsedPatch {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const files: FilePatch[] = [];
  const issues: PatchIssue[] = [];
  let cur: FilePatch | null = null;
  let hunk: DiffHunk | null = null;

  const startFile = (): FilePatch => {
    const f: FilePatch = { oldPath: null, newPath: null, status: 'modified', hunks: [], additions: 0, deletions: 0, binary: false, path: '' };
    files.push(f);
    hunk = null;
    return f;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      cur = startFile();
      const m = /^diff --git (\S+) (\S+)$/.exec(line);
      if (m) {
        cur.oldPath = stripPrefix(m[1]!);
        cur.newPath = stripPrefix(m[2]!);
      }
      continue;
    }
    if (line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
      if (!cur || cur.hunks.length > 0 || (cur.oldPath === null && cur.newPath === null && files.length === 0)) cur = startFile();
      else if (cur.oldPath !== null && cur.hunks.length === 0 && !lines[i - 1]?.match(/^(index|new file|deleted file|similarity|rename|old mode|new mode|diff --git)/)) cur = startFile();
      cur.oldPath = stripPrefix(line.slice(4));
      cur.newPath = stripPrefix(lines[i + 1]!.slice(4));
      i++;
      hunk = null;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('new file mode')) {
      cur.status = 'added';
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      cur.status = 'deleted';
      continue;
    }
    if (line.startsWith('rename from ')) {
      cur.oldPath = line.slice(12).trim();
      cur.status = 'renamed';
      continue;
    }
    if (line.startsWith('rename to ')) {
      cur.newPath = line.slice(10).trim();
      cur.status = 'renamed';
      continue;
    }
    if (/^Binary files .* differ$/.test(line) || line.startsWith('GIT binary patch')) {
      cur.binary = true;
      continue;
    }
    const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(line);
    if (hm) {
      hunk = {
        oldStart: Number(hm[1]),
        oldLines: hm[2] === undefined ? 1 : Number(hm[2]),
        newStart: Number(hm[3]),
        newLines: hm[4] === undefined ? 1 : Number(hm[4]),
        section: hm[5] ?? '',
        lines: []
      };
      cur.hunks.push(hunk);
      continue;
    }
    if (/^@@/.test(line)) {
      issues.push({ severity: 'error', line: i + 1, message: `Malformed hunk header: ${line.slice(0, 80)}` });
      hunk = null;
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    const t = line[0];
    if (t === ' ' || t === '+' || t === '-') {
      hunk.lines.push({ type: t, text: line.slice(1) });
    } else if (line === '') {
      // Many LLMs drop the leading space on blank context lines.
      const isLast = i === lines.length - 1;
      if (!isLast) hunk.lines.push({ type: ' ', text: '' });
    } else {
      hunk = null;
    }
  }

  for (const f of files) {
    f.path = f.newPath ?? f.oldPath ?? '';
    if (f.oldPath === null && f.newPath !== null) f.status = 'added';
    else if (f.newPath === null && f.oldPath !== null) f.status = 'deleted';
    else if (f.oldPath && f.newPath && f.oldPath !== f.newPath) f.status = 'renamed';
    for (const h of f.hunks) {
      // Trim trailing blank context lines that were artefacts of the blank-line leniency.
      while (h.lines.length && h.lines[h.lines.length - 1]!.type === ' ' && h.lines[h.lines.length - 1]!.text === '') {
        const old = h.lines.filter((l) => l.type !== '+').length;
        if (old <= h.oldLines) break;
        h.lines.pop();
      }
      const oldCount = h.lines.filter((l) => l.type !== '+').length;
      const newCount = h.lines.filter((l) => l.type !== '-').length;
      if (oldCount !== h.oldLines || newCount !== h.newLines) {
        issues.push({
          severity: 'warning',
          path: f.path,
          message: `Hunk @@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@ has ${oldCount} old / ${newCount} new lines; header counts were recomputed.`
        });
        h.oldLines = oldCount;
        h.newLines = newCount;
        h.recounted = true;
      }
      f.additions += h.lines.filter((l) => l.type === '+').length;
      f.deletions += h.lines.filter((l) => l.type === '-').length;
    }
    if (!f.path) issues.push({ severity: 'error', message: 'A file section has no path.' });
    if (f.hunks.length === 0 && !f.binary && f.status === 'modified') issues.push({ severity: 'warning', path: f.path, message: 'File section has no hunks.' });
    if (f.binary) issues.push({ severity: 'error', path: f.path, message: 'Binary patches are not supported.' });
  }
  if (files.length === 0) issues.push({ severity: 'error', message: 'No unified diff found. Expected lines starting with `diff --git`, `---`/`+++` and `@@`.' });
  return { files, issues };
}

/** Serializes a parsed patch back into a canonical git-style unified diff (with corrected counts). */
export function formatUnifiedDiff(patch: ParsedPatch | FilePatch[]): string {
  const files = Array.isArray(patch) ? patch : patch.files;
  const out: string[] = [];
  for (const f of files) {
    const a = f.oldPath ?? f.newPath!;
    const b = f.newPath ?? f.oldPath!;
    out.push(`diff --git a/${a} b/${b}`);
    if (f.status === 'added') out.push('new file mode 100644');
    if (f.status === 'deleted') out.push('deleted file mode 100644');
    if (f.status === 'renamed') out.push(`rename from ${f.oldPath}`, `rename to ${f.newPath}`);
    if (f.hunks.length) {
      out.push(`--- ${f.oldPath ? `a/${f.oldPath}` : '/dev/null'}`);
      out.push(`+++ ${f.newPath ? `b/${f.newPath}` : '/dev/null'}`);
    }
    for (const h of f.hunks) {
      const oldStart = h.oldLines === 0 && h.oldStart > 0 && f.status === 'added' ? 0 : h.oldStart;
      out.push(`@@ -${oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@${h.section ? ' ' + h.section : ''}`);
      for (const l of h.lines) out.push(`${l.type}${l.text}`);
    }
  }
  return out.join('\n') + '\n';
}

// ------------------------------------------------------------------ extraction from AI responses

export interface ExtractedChange {
  kind: 'diff' | 'file';
  path?: string;
  language?: string;
  content: string;
}

const PATH_HINT = /(?:^|\s|\*\*|`|#+\s*|File:\s*|FILENAME:\s*|PATH:\s*|\/\/\s*|#\s*)([\w@.-]+(?:\/[\w@.-]+)+\.[A-Za-z0-9]+|[\w@-]+\.(?:kt|kts|java|ts|tsx|js|jsx|py|rs|go|c|cpp|h|hpp|xml|gradle|json|toml|ya?ml|md))(?:`|\*\*|:|\s|$)/;

/**
 * Pulls diffs and whole-file code blocks out of a pasted DeepSeek response.
 * Fenced ```diff/```patch blocks win; bare diffs are detected too; other fenced blocks become
 * whole-file candidates when a file path is named right before (or on the first line of) the block.
 */
export function extractChanges(response: string): ExtractedChange[] {
  const out: ExtractedChange[] = [];
  const text = response.replace(/\r\n/g, '\n');
  const fence = /(^|\n)(```+|~~~+)[ \t]*([\w+#.-]*)[^\n]*\n([\s\S]*?)\n\2[ \t]*(?=\n|$)/g;
  let m: RegExpExecArray | null;
  let lastEnd = 0;
  let sawFence = false;
  while ((m = fence.exec(text))) {
    sawFence = true;
    const lang = (m[3] ?? '').toLowerCase();
    const body = m[4]!;
    const before = text.slice(Math.max(lastEnd, m.index - 300), m.index);
    lastEnd = m.index + m[0].length;
    const looksDiff = lang === 'diff' || lang === 'patch' || /^(diff --git |--- \S|@@ -\d)/m.test(body) && /^\+\+\+ /m.test(body);
    if (looksDiff) {
      out.push({ kind: 'diff', content: body });
      continue;
    }
    const beforeLines = before.trimEnd().split('\n');
    const hintLine = beforeLines[beforeLines.length - 1] ?? '';
    let path = PATH_HINT.exec(hintLine)?.[1];
    let content = body;
    const firstLine = body.split('\n')[0] ?? '';
    const firstHint = /^\s*(?:\/\/|#|<!--|--)\s*(?:File:\s*|Path:\s*)?([\w@.-]+(?:\/[\w@.-]+)+\.[A-Za-z0-9]+)\s*(?:-->)?\s*$/.exec(firstLine);
    if (firstHint) {
      path = firstHint[1];
      content = body.split('\n').slice(1).join('\n');
    }
    if (path) out.push({ kind: 'file', path: path.replace(/^\.\//, ''), language: lang || undefined, content: content.endsWith('\n') ? content : content + '\n' });
  }
  if (!sawFence || out.length === 0) {
    const idx = text.search(/^(diff --git |--- (a\/|\/dev\/null)\S*)/m);
    if (idx >= 0) out.push({ kind: 'diff', content: text.slice(idx) });
  }
  return out;
}

// ------------------------------------------------------------------ Myers line diff -> unified diff

type Op = { t: ' ' | '+' | '-'; line: string };

function myers(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  const off = max + 1;
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        trace.push(v.slice());
        break outer;
      }
    }
  }
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 2; d >= 0; d--) {
    const vv = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && vv[off + k - 1]! < vv[off + k + 1]!) ? k + 1 : k - 1;
    const prevX = vv[off + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ t: ' ', line: a[x - 1]! });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) ops.push({ t: '+', line: b[y - 1]! });
      else ops.push({ t: '-', line: a[x - 1]! });
    }
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

function splitLines(s: string): string[] {
  if (s === '') return [];
  const lines = s.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Produces a FilePatch describing `oldText -> newText` with `context` lines of context. */
export function diffTexts(path: string, oldText: string | null, newText: string | null, context = 3): FilePatch {
  const a = oldText === null ? [] : splitLines(oldText);
  const b = newText === null ? [] : splitLines(newText);
  const ops = a.length + b.length > 40_000 ? [...a.map((line) => ({ t: '-' as const, line })), ...b.map((line) => ({ t: '+' as const, line }))] : myers(a, b);
  const hunks: DiffHunk[] = [];
  let i = 0;
  let oldLine = 1;
  let newLine = 1;
  const pos: { o: number; n: number }[] = [];
  for (const op of ops) {
    pos.push({ o: oldLine, n: newLine });
    if (op.t !== '+') oldLine++;
    if (op.t !== '-') newLine++;
  }
  while (i < ops.length) {
    if (ops[i]!.t === ' ') {
      i++;
      continue;
    }
    let start = Math.max(0, i - context);
    let end = i;
    // Extend while changes are within 2*context of each other.
    while (end < ops.length) {
      if (ops[end]!.t !== ' ') {
        end++;
        continue;
      }
      let j = end;
      while (j < ops.length && ops[j]!.t === ' ') j++;
      if (j < ops.length && j - end <= 2 * context) end = j;
      else {
        end = Math.min(ops.length, end + context);
        break;
      }
    }
    const slice = ops.slice(start, end);
    const p0 = pos[start]!;
    const oldCount = slice.filter((o) => o.t !== '+').length;
    const newCount = slice.filter((o) => o.t !== '-').length;
    hunks.push({
      oldStart: oldCount === 0 ? Math.max(0, p0.o - 1) : p0.o,
      oldLines: oldCount,
      newStart: newCount === 0 ? Math.max(0, p0.n - 1) : p0.n,
      newLines: newCount,
      section: '',
      lines: slice.map((o) => ({ type: o.t, text: o.line }))
    });
    i = end;
    start = end;
  }
  const status: FileStatus = oldText === null ? 'added' : newText === null ? 'deleted' : 'modified';
  return {
    oldPath: oldText === null ? null : path,
    newPath: newText === null ? null : path,
    status,
    hunks,
    additions: ops.filter((o) => o.t === '+').length,
    deletions: ops.filter((o) => o.t === '-').length,
    binary: false,
    path
  };
}

// ------------------------------------------------------------------ in-memory application

export interface ApplyResult {
  ok: boolean;
  content: string | null;
  /** Hunks that could not be placed. */
  failed: { hunk: number; reason: string }[];
  /** Hunks applied at a different line than the header said, or with whitespace-insensitive matching. */
  fuzzy: { hunk: number; offset: number; whitespace: boolean }[];
}

function matchAt(src: string[], at: number, expect: string[], loose: boolean): boolean {
  if (at < 0 || at + expect.length > src.length) return false;
  for (let k = 0; k < expect.length; k++) {
    const x = src[at + k]!;
    const y = expect[k]!;
    if (loose ? x.trim() !== y.trim() : x !== y) return false;
  }
  return true;
}

/**
 * Applies a FilePatch to file content without touching disk. Used for previews, regression analysis
 * and as the patch engine for non-git local folders.
 */
export function applyFilePatch(original: string | null, patch: FilePatch, maxOffset = 200): ApplyResult {
  if (patch.status === 'deleted') return { ok: true, content: null, failed: [], fuzzy: [] };
  const hadTrailingNewline = original === null || original === '' || original.endsWith('\n');
  const src = original === null ? [] : splitLines(original);
  const out: string[] = [];
  const failed: ApplyResult['failed'] = [];
  const fuzzy: ApplyResult['fuzzy'] = [];
  let cursor = 0;
  patch.hunks.forEach((h, idx) => {
    const expect = h.lines.filter((l) => l.type !== '+').map((l) => l.text);
    const replacement = h.lines.filter((l) => l.type !== '-').map((l) => l.text);
    const want = Math.max(0, h.oldStart - 1);
    let found = -1;
    let loose = false;
    if (expect.length === 0) found = Math.max(cursor, Math.min(want, src.length));
    else {
      for (const isLoose of [false, true]) {
        for (let d = 0; d <= maxOffset && found < 0; d++) {
          for (const at of d === 0 ? [want] : [want - d, want + d]) {
            if (at >= cursor && matchAt(src, at, expect, isLoose)) {
              found = at;
              break;
            }
          }
        }
        if (found >= 0) {
          loose = isLoose;
          break;
        }
      }
    }
    if (found < 0) {
      failed.push({ hunk: idx, reason: `Context for hunk ${idx + 1} (@@ -${h.oldStart},${h.oldLines}) not found in the current file.` });
      return;
    }
    if (found !== want || loose) fuzzy.push({ hunk: idx, offset: found - want, whitespace: loose });
    for (let k = cursor; k < found; k++) out.push(src[k]!);
    out.push(...replacement);
    cursor = found + expect.length;
  });
  for (let k = cursor; k < src.length; k++) out.push(src[k]!);
  if (failed.length) return { ok: false, content: null, failed, fuzzy };
  const text = out.join('\n') + (out.length && hadTrailingNewline ? '\n' : '');
  return { ok: true, content: text, failed, fuzzy };
}

// ------------------------------------------------------------------ path validation

export interface PathValidationOptions {
  knownFiles: Set<string>;
  allowSecretFiles?: boolean;
  allowDeletes?: boolean;
}

/** Validates every path in a patch against the repository. Errors block application. */
export function validatePatchPaths(patch: ParsedPatch, opts: PathValidationOptions): PatchIssue[] {
  const issues: PatchIssue[] = [];
  for (const f of patch.files) {
    for (const raw of [f.oldPath, f.newPath]) {
      if (raw === null) continue;
      if (raw.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('~')) {
        issues.push({ severity: 'error', path: raw, message: 'Absolute path in patch — refusing to touch files outside the repository.' });
        continue;
      }
      const norm = normalizeRepoPath(raw);
      if (norm === null) {
        issues.push({ severity: 'error', path: raw, message: 'Path escapes the repository (contains `..`) or is invalid.' });
        continue;
      }
      if (norm !== raw.replace(/^\.\//, '')) issues.push({ severity: 'warning', path: raw, message: `Path normalized to ${norm}.` });
      if (/(^|\/)\.git(\/|$)/.test(norm)) issues.push({ severity: 'error', path: norm, message: 'Patch modifies git internals (.git/).' });
      if (isSecretFile(norm) && !opts.allowSecretFiles) issues.push({ severity: 'error', path: norm, message: 'Patch modifies a secret/credential file. Blocked by default.' });
    }
    if (f.status === 'modified' && !opts.knownFiles.has(f.path)) issues.push({ severity: 'warning', path: f.path, message: 'File is not in the index (new, ignored, or index is stale).' });
    if (f.status === 'added' && opts.knownFiles.has(f.path)) issues.push({ severity: 'error', path: f.path, message: 'Patch creates a file that already exists.' });
    if (f.status === 'deleted') {
      issues.push({ severity: opts.allowDeletes ? 'warning' : 'error', path: f.path, message: opts.allowDeletes ? 'Patch deletes this file.' : 'Patch deletes this file. Enable “allow deletions” to proceed.' });
    }
    if (f.status === 'renamed' && f.oldPath && !opts.knownFiles.has(f.oldPath)) issues.push({ severity: 'warning', path: f.oldPath, message: 'Rename source is not in the index.' });
  }
  return issues;
}
