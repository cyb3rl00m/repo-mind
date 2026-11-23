/**
 * Offset-preserving lexical scanner.
 *
 * Produces two views of a source file with identical length and line structure:
 *  - `noComments`: comments blanked out (strings intact) — used for import extraction.
 *  - `code`: comments AND string/char literal bodies blanked out — used for symbol extraction,
 *    so declarations inside strings or comments are never reported as real symbols.
 */
export type CommentStyle = 'c' | 'hash' | 'xml' | 'none';

export interface ScanOptions {
  comments: CommentStyle;
  /** Allow nested block comments (Kotlin, Rust, Swift). */
  nestedBlock?: boolean;
  /** Language uses `'` for strings (JS/TS/Python/shell) rather than char literals. */
  singleQuoteStrings?: boolean;
  /** Backtick strings (JS template literals, Go raw strings). */
  backtick?: boolean;
  /** Python/Kotlin triple-quoted strings. */
  tripleQuotes?: boolean;
  /** Rust raw strings r"..." / r#"..."#. */
  rustRaw?: boolean;
}

export interface Scanned {
  noComments: string;
  code: string;
}

function blank(ch: string): string {
  return ch === '\n' ? '\n' : ' ';
}

export function scanSource(src: string, opt: ScanOptions): Scanned {
  const n = src.length;
  const a: string[] = new Array(n); // noComments
  const b: string[] = new Array(n); // code
  let i = 0;
  const copy = (from: number, to: number, keepA: boolean, keepB: boolean) => {
    for (let k = from; k < to && k < n; k++) {
      const ch = src[k]!;
      a[k] = keepA ? ch : blank(ch);
      b[k] = keepB ? ch : blank(ch);
    }
  };

  while (i < n) {
    const c = src[i]!;
    const next = src[i + 1];

    // Comments
    if (opt.comments === 'c' && c === '/' && next === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      copy(i, j, false, false);
      i = j;
      continue;
    }
    if (opt.comments === 'c' && c === '/' && next === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (opt.nestedBlock && src[j] === '/' && src[j + 1] === '*') {
          depth++;
          j += 2;
        } else if (src[j] === '*' && src[j + 1] === '/') {
          depth--;
          j += 2;
        } else j++;
      }
      copy(i, j, false, false);
      i = j;
      continue;
    }
    if (opt.comments === 'hash' && c === '#') {
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      copy(i, j, false, false);
      i = j;
      continue;
    }
    if (opt.comments === 'xml' && src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      const j = end < 0 ? n : end + 3;
      copy(i, j, false, false);
      i = j;
      continue;
    }

    // Strings
    if (opt.tripleQuotes && (src.startsWith('"""', i) || (opt.singleQuoteStrings && src.startsWith("'''", i)))) {
      const q = src.slice(i, i + 3);
      const end = src.indexOf(q, i + 3);
      const j = end < 0 ? n : end + 3;
      copy(i, i + 3, true, true);
      copy(i + 3, j - 3, true, false);
      copy(Math.max(i + 3, j - 3), j, true, true);
      i = j;
      continue;
    }
    if (opt.rustRaw && c === 'r' && (next === '"' || next === '#') && !/[A-Za-z0-9_]/.test(src[i - 1] ?? '')) {
      let j = i + 1;
      let hashes = 0;
      while (src[j] === '#') {
        hashes++;
        j++;
      }
      if (src[j] === '"') {
        const terminator = '"' + '#'.repeat(hashes);
        const end = src.indexOf(terminator, j + 1);
        const stop = end < 0 ? n : end + terminator.length;
        copy(i, j + 1, true, true);
        copy(j + 1, stop - terminator.length, true, false);
        copy(Math.max(j + 1, stop - terminator.length), stop, true, true);
        i = stop;
        continue;
      }
    }
    if (c === '"' || (c === "'" && opt.singleQuoteStrings) || (c === '`' && opt.backtick)) {
      let j = i + 1;
      while (j < n) {
        const d = src[j]!;
        if (d === '\\' && c !== '`') {
          j += 2;
          continue;
        }
        if (d === '\\' && c === '`' && opt.singleQuoteStrings) {
          j += 2;
          continue;
        }
        if (d === c) break;
        if (d === '\n' && c !== '`') break;
        j++;
      }
      const stop = Math.min(n, j + 1);
      copy(i, i + 1, true, true);
      copy(i + 1, j, true, false);
      copy(j, stop, true, true);
      i = stop;
      continue;
    }
    if (c === "'" && !opt.singleQuoteStrings) {
      // Char literal: 'a', '\n', '\u0000'. Rust lifetimes ('a) have no closing quote nearby.
      const m = /^'(\\u\{?[0-9a-fA-F]{1,6}\}?|\\.|[^'\\\n])'/.exec(src.slice(i, i + 12));
      if (m) {
        const stop = i + m[0].length;
        copy(i, i + 1, true, true);
        copy(i + 1, stop - 1, true, false);
        copy(stop - 1, stop, true, true);
        i = stop;
        continue;
      }
    }
    a[i] = c;
    b[i] = c;
    i++;
  }
  return { noComments: a.join(''), code: b.join('') };
}

/** 1-based line number for each offset, computed lazily. */
export class LineMap {
  private readonly starts: number[] = [0];
  constructor(text: string) {
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) this.starts.push(i + 1);
  }
  lineAt(offset: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }
  get lineCount(): number {
    return this.starts.length;
  }
}

/** Returns the original source line (trimmed, capped) for signatures. */
export function lineText(src: string, line: number, maxLen = 240): string {
  let start = 0;
  for (let l = 1; l < line; l++) {
    const nl = src.indexOf('\n', start);
    if (nl < 0) return '';
    start = nl + 1;
  }
  const end = src.indexOf('\n', start);
  const text = src.slice(start, end < 0 ? undefined : end).trim();
  return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
}

/**
 * Captures a declaration signature: from the declaration line up to the first `{`, `=` (expression
 * body) or `:`-terminated header, spanning at most `maxLines` lines. Used for signature diffing.
 */
export function signatureFrom(src: string, line: number, maxLines = 6): string {
  const lines = src.split('\n');
  const parts: string[] = [];
  let depth = 0;
  for (let l = line - 1; l < lines.length && l < line - 1 + maxLines; l++) {
    const t = lines[l]!.trim();
    parts.push(t);
    for (const ch of t) {
      if (ch === '(' || ch === '<' || ch === '[') depth++;
      else if (ch === ')' || ch === '>' || ch === ']') depth = Math.max(0, depth - 1);
    }
    if (depth === 0 && /[{;]\s*$|=\s*$|=>?\s*\S|\)\s*(:\s*[\w.<>?, [\]]+)?\s*$|:\s*$/.test(t)) break;
  }
  let sig = parts.join(' ').replace(/\s+/g, ' ');
  const brace = sig.indexOf('{');
  if (brace > 0) sig = sig.slice(0, brace).trim();
  return sig.length > 300 ? `${sig.slice(0, 300)}…` : sig;
}
