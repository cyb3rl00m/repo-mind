import { LineMap, scanSource, signatureFrom } from './scan.js';
import { ContainerStack, lineDepths, returnTypeFrom, sym, type ParseResult } from './util.js';
import type { ImportRef, SymbolInfo, SymbolKind } from '../types.js';

// ---------------------------------------------------------------- Python

export function parsePython(src: string): ParseResult {
  const { noComments, code } = scanSource(src, { comments: 'hash', singleQuoteStrings: true, tripleQuotes: true });
  const lm = new LineMap(src);
  const imports: ImportRef[] = [];
  // Join parenthesized `from x import (\n a,\n b)` lists.
  for (const m of noComments.matchAll(/^[ \t]*from\s+(\.*[\w.]*)\s+import\s+(\([^)]*\)|[^\n]+)/gm)) {
    const names = m[2]!
      .replace(/[()\\]/g, ' ')
      .split(',')
      .map((s) => s.trim().split(/\s+as\s+/)[0]!.trim())
      .filter(Boolean);
    imports.push({ spec: m[1]!, line: lm.lineAt(m.index!), kind: 'import', names });
  }
  for (const m of noComments.matchAll(/^[ \t]*import\s+([^\n]+)/gm)) {
    for (const part of m[1]!.split(',')) {
      const spec = part.trim().split(/\s+as\s+/)[0]!.trim();
      if (/^[\w.]+$/.test(spec)) imports.push({ spec, line: lm.lineAt(m.index!), kind: 'import', names: [spec.split('.').pop()!] });
    }
  }

  const lines = code.split('\n');
  const srcLines = src.split('\n');
  const symbols: SymbolInfo[] = [];
  const stack: { name: string; indent: number; type: 'type' | 'function' }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    while (stack.length && indent <= stack[stack.length - 1]!.indent) stack.pop();
    const lineNo = i + 1;
    const decorators: string[] = [];
    for (let k = i - 1; k >= 0 && k >= i - 5; k--) {
      const t = srcLines[k]!.trim();
      if (!t.startsWith('@')) break;
      decorators.push(t.slice(1).split('(')[0]!);
    }
    const inFn = stack.some((s) => s.type === 'function');
    const container = [...stack].reverse().find((s) => s.type === 'type')?.name;
    const fn = /^\s*(async\s+)?def\s+(\w+)\s*(\[[^\]]*\])?\s*\(/.exec(line);
    if (fn) {
      const name = fn[2]!;
      const signature = signatureFrom(src, lineNo).replace(/:\s*$/, '');
      if (!inFn) {
        symbols.push(
          sym(name, container ? 'method' : 'function', lineNo, signature, {
            exported: !name.startsWith('_') || /^__\w+__$/.test(name),
            container,
            returnType: returnTypeFrom(signature, 'arrow')?.replace(/:$/, ''),
            annotations: decorators
          })
        );
      }
      stack.push({ name, indent, type: 'function' });
      continue;
    }
    const cls = /^\s*class\s+(\w+)/.exec(line);
    if (cls) {
      if (!inFn) symbols.push(sym(cls[1]!, 'class', lineNo, signatureFrom(src, lineNo).replace(/:\s*$/, ''), { exported: !cls[1]!.startsWith('_'), container, annotations: decorators }));
      stack.push({ name: cls[1]!, indent, type: 'type' });
      continue;
    }
    if (indent === 0) {
      const v = /^([A-Za-z_]\w*)\s*(:\s*[^=]+)?=(?!=)/.exec(line);
      if (v) {
        const name = v[1]!;
        symbols.push(sym(name, /^[A-Z][A-Z0-9_]*$/.test(name) ? 'constant' : 'variable', lineNo, srcLines[i]!.trim().slice(0, 200), { exported: !name.startsWith('_') }));
      }
    }
  }
  const hasMain = /^if\s+__name__\s*==\s*["']__main__["']\s*:/m.test(noComments);
  return { symbols, imports, resourceRefs: [], notes: [], fidelity: 'lexical', hasMain };
}

// ---------------------------------------------------------------- Rust

export function parseRust(src: string): ParseResult {
  const { noComments, code } = scanSource(src, { comments: 'c', nestedBlock: true, rustRaw: true });
  const lm = new LineMap(src);
  const imports: ImportRef[] = [];
  for (const m of noComments.matchAll(/(^|\n)\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([^;]+);/g)) {
    const raw = m[2]!.replace(/\s+/g, '');
    imports.push({ spec: raw, line: lm.lineAt(m.index! + m[1]!.length), kind: 'use' });
  }
  for (const m of noComments.matchAll(/(^|\n)\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/g)) {
    imports.push({ spec: m[2]!, line: lm.lineAt(m.index! + m[1]!.length), kind: 'mod' });
  }
  for (const m of noComments.matchAll(/(^|\n)\s*extern\s+crate\s+(\w+)/g)) {
    imports.push({ spec: m[2]!, line: lm.lineAt(m.index! + m[1]!.length), kind: 'use' });
  }
  const lines = code.split('\n');
  const depths = lineDepths(code);
  const stack = new ContainerStack();
  const symbols: SymbolInfo[] = [];
  let hasMain = false;
  const DECL = /^\s*(pub(?:\([^)]*\))?\s+)?((?:async|const|unsafe|default|extern\s+"[^"]*")\s+)*(fn|struct|enum|trait|type|mod|const|static|union)\s+(\w+)/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const depth = depths[i] ?? 0;
    stack.sync(depth);
    const lineNo = i + 1;
    const impl = /^\s*(?:unsafe\s+)?impl(?:\s*<[^>]*>)?\s+(?:([\w:<>, ]+?)\s+for\s+)?([\w:]+)/.exec(line);
    if (impl && !stack.inFunction) {
      stack.push({ name: impl[2]!.split('::').pop()!, depth, type: 'type' });
      continue;
    }
    const macro = /^\s*macro_rules!\s+(\w+)/.exec(line);
    if (macro) {
      symbols.push(sym(macro[1]!, 'function', lineNo, line.trim(), { exported: true }));
      continue;
    }
    const m = DECL.exec(line);
    if (!m || stack.inFunction) {
      if (m?.[3] === 'fn') stack.push({ name: m[4]!, depth, type: 'function' });
      continue;
    }
    const kw = m[3]!;
    const name = m[4]!;
    const signature = signatureFrom(src, lineNo);
    const exported = Boolean(m[1]);
    const container = stack.typeName;
    const kindMap: Record<string, SymbolKind> = {
      fn: container ? 'method' : 'function',
      struct: 'struct',
      enum: 'enum',
      trait: 'trait',
      type: 'type',
      mod: 'module',
      const: 'constant',
      static: 'variable',
      union: 'struct'
    };
    if (kw === 'mod' && /;\s*$/.test(line)) continue; // `mod foo;` is an import, recorded above
    symbols.push(
      sym(name, kindMap[kw]!, lineNo, signature, {
        exported,
        container,
        returnType: kw === 'fn' ? returnTypeFrom(signature, 'arrow') ?? '()' : undefined
      })
    );
    if (kw === 'fn') {
      if (name === 'main' && !container) hasMain = true;
      stack.push({ name, depth, type: 'function' });
    } else if (kw === 'trait' || kw === 'mod') stack.push({ name, depth, type: 'type' });
  }
  return { symbols, imports, resourceRefs: [], notes: [], fidelity: 'lexical', hasMain };
}

// ---------------------------------------------------------------- Go

export function parseGo(src: string): ParseResult {
  const { noComments, code } = scanSource(src, { comments: 'c', backtick: true });
  const lm = new LineMap(src);
  const pkg = /^\s*package\s+(\w+)/m.exec(noComments)?.[1];
  const imports: ImportRef[] = [];
  for (const m of noComments.matchAll(/^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"/gm)) {
    imports.push({ spec: m[1]!, line: lm.lineAt(m.index!), kind: 'import' });
  }
  for (const block of noComments.matchAll(/^\s*import\s*\(([^)]*)\)/gm)) {
    const startLine = lm.lineAt(block.index!);
    const body = block[1]!;
    const bodyLines = body.split('\n');
    bodyLines.forEach((l, k) => {
      const mm = /^\s*(?:[\w.]+\s+)?"([^"]+)"/.exec(l);
      if (mm) imports.push({ spec: mm[1]!, line: startLine + k, kind: 'import' });
    });
  }
  const lines = code.split('\n');
  const depths = lineDepths(code);
  const symbols: SymbolInfo[] = [];
  let inTypeBlock = false;
  let inConstBlock: 'const' | 'var' | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const depth = depths[i] ?? 0;
    const lineNo = i + 1;
    if (depth !== 0) continue;
    if (/^\)/.test(line)) {
      inTypeBlock = false;
      inConstBlock = null;
      continue;
    }
    if (inTypeBlock) {
      const t = /^\s+(\w+)\s+(struct|interface|func|[\w.[\]*]+)/.exec(line);
      if (t) symbols.push(sym(t[1]!, t[2] === 'struct' ? 'struct' : t[2] === 'interface' ? 'interface' : 'type', lineNo, line.trim(), { exported: /^[A-Z]/.test(t[1]!) }));
      continue;
    }
    if (inConstBlock) {
      const c = /^\s+(\w+)/.exec(line);
      if (c && c[1] !== '_') symbols.push(sym(c[1]!, inConstBlock === 'const' ? 'constant' : 'variable', lineNo, line.trim(), { exported: /^[A-Z]/.test(c[1]!) }));
      continue;
    }
    const fn = /^func\s+(?:\(\s*\w*\s*\*?\s*([\w]+)(?:\[[^\]]*\])?\s*\)\s*)?(\w+)\s*(\[[^\]]*\])?\s*\(/.exec(line);
    if (fn) {
      const signature = signatureFrom(src, lineNo);
      const after = signature.replace(/^func\s+(\([^)]*\)\s*)?\w+\s*(\[[^\]]*\])?\s*\([^)]*\)\s*/, '');
      symbols.push(
        sym(fn[2]!, fn[1] ? 'method' : 'function', lineNo, signature, {
          exported: /^[A-Z]/.test(fn[2]!),
          container: fn[1],
          returnType: after.trim() || undefined
        })
      );
      continue;
    }
    if (/^type\s*\(/.test(line)) {
      inTypeBlock = true;
      continue;
    }
    const ty = /^type\s+(\w+)(?:\[[^\]]*\])?\s+(struct|interface|func|[\w.[\]*]+)/.exec(line);
    if (ty) {
      symbols.push(sym(ty[1]!, ty[2] === 'struct' ? 'struct' : ty[2] === 'interface' ? 'interface' : 'type', lineNo, signatureFrom(src, lineNo), { exported: /^[A-Z]/.test(ty[1]!) }));
      continue;
    }
    const cb = /^(const|var)\s*\(/.exec(line);
    if (cb) {
      inConstBlock = cb[1] as 'const' | 'var';
      continue;
    }
    const cv = /^(const|var)\s+(\w+)/.exec(line);
    if (cv) symbols.push(sym(cv[2]!, cv[1] === 'const' ? 'constant' : 'variable', lineNo, line.trim(), { exported: /^[A-Z]/.test(cv[2]!) }));
  }
  const hasMain = pkg === 'main' && symbols.some((s) => s.name === 'main' && s.kind === 'function');
  return { pkg, symbols, imports, resourceRefs: [], notes: [], fidelity: 'lexical', hasMain };
}

// ---------------------------------------------------------------- C / C++

const C_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'return', 'sizeof', 'catch', 'else', 'do', 'case', 'defined']);

export function parseCFamily(src: string, cpp: boolean): ParseResult {
  const { noComments, code } = scanSource(src, { comments: 'c' });
  const lm = new LineMap(src);
  const imports: ImportRef[] = [];
  for (const m of noComments.matchAll(/^\s*#\s*include\s*([<"])([^>"]+)[>"]/gm)) {
    imports.push({ spec: m[1] === '"' ? m[2]! : `<${m[2]}>`, line: lm.lineAt(m.index!), kind: 'include' });
  }
  const lines = code.split('\n');
  const depths = lineDepths(code);
  const symbols: SymbolInfo[] = [];
  const nsStack = new ContainerStack();
  let hasMain = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const depth = depths[i] ?? 0;
    nsStack.sync(depth);
    const lineNo = i + 1;
    if (line.trimStart().startsWith('#')) {
      const def = /^\s*#\s*define\s+(\w+)/.exec(line);
      if (def) symbols.push(sym(def[1]!, 'constant', lineNo, line.trim()));
      continue;
    }
    const ns = cpp ? /^\s*namespace\s+([\w:]+)\s*\{?/.exec(line) : null;
    if (ns) {
      nsStack.push({ name: ns[1]!, depth, type: 'block' });
      continue;
    }
    const typeDepthOk = depth === (nsStack.top ? nsStack.top.depth + 1 : 0) || depth === 0;
    if (!typeDepthOk) continue;
    const ty = /^\s*(?:typedef\s+)?(?:template\s*<[^>]*>\s*)?(struct|class|enum(?:\s+class)?|union)\s+(\w+)\s*(?:final\s*)?(?::[^{;]*)?(\{|$)/.exec(line);
    if (ty) {
      const kind: SymbolKind = ty[1] === 'class' ? 'class' : ty[1]!.startsWith('enum') ? 'enum' : 'struct';
      symbols.push(sym(ty[2]!, kind, lineNo, signatureFrom(src, lineNo)));
      continue;
    }
    const fn = /^\s*(?:template\s*<[^>]*>\s*)?(?:(?:static|inline|extern|virtual|constexpr|explicit)\s+)*([\w:<>,*&\s]+?)[\s*&]+([~\w:]+)\s*\(/.exec(line);
    if (fn && !C_KEYWORDS.has(fn[2]!.split('::').pop()!) && !/^\s*(return|else|case)\b/.test(line)) {
      const ahead = lines.slice(i, i + 4).join(' ');
      const header = ahead.slice(0, ahead.indexOf('{') < 0 ? undefined : ahead.indexOf('{'));
      if (ahead.includes('{') && !header.includes(';') && /\)\s*(const)?\s*(noexcept)?\s*(override)?\s*$/.test(header.trimEnd())) {
        const full = fn[2]!;
        const parts = full.split('::');
        const name = parts.pop()!;
        symbols.push(
          sym(name, parts.length ? 'method' : 'function', lineNo, signatureFrom(src, lineNo), {
            exported: !/^\s*static\b/.test(line),
            container: parts.length ? parts.join('::') : undefined,
            returnType: fn[1]!.trim()
          })
        );
        if (name === 'main' && !parts.length) hasMain = true;
      }
    }
  }
  return { symbols, imports, resourceRefs: [], notes: [], fidelity: 'lexical', hasMain };
}
