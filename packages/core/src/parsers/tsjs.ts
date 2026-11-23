import { LineMap, scanSource, signatureFrom } from './scan.js';
import { ContainerStack, lineDepths, returnTypeFrom, sym, type ParseResult } from './util.js';
import type { ImportRef, SymbolInfo, SymbolKind } from '../types.js';

const DECL =
  /^\s*(export\s+)?(default\s+)?(declare\s+)?(abstract\s+)?(async\s+)?(function\*?|class|interface|type|enum|const enum|const|let|var|namespace|module)\s+([A-Za-z_$][\w$]*)/;
const METHOD =
  /^\s*(?:(?:public|private|protected|static|readonly|override|abstract|declare|async|get|set|accessor)\s+)*(#?[A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/;
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'constructor', 'super', 'new', 'await', 'typeof', 'with']);

function parseNames(clause: string): string[] {
  const names: string[] = [];
  const braces = /\{([^}]*)\}/.exec(clause);
  if (braces) {
    for (const part of braces[1]!.split(',')) {
      const n = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!.trim();
      if (n) names.push(n);
    }
  }
  const def = /^\s*(?:type\s+)?([A-Za-z_$][\w$]*)\s*(,|$)/.exec(clause);
  if (def && def[1] !== 'type') names.push('default');
  if (/\*\s+as\s+\w+/.test(clause)) names.push('*');
  return names;
}

export function parseTsJs(src: string, typescript: boolean): ParseResult {
  const { noComments, code } = scanSource(src, { comments: 'c', singleQuoteStrings: true, backtick: true });
  const lm = new LineMap(src);
  const imports: ImportRef[] = [];

  for (const m of noComments.matchAll(/(^|[;\n])\s*import\s+(type\s+)?([\w$*{}\s,]+?)\s+from\s+["']([^"']+)["']/g)) {
    imports.push({ spec: m[4]!, line: lm.lineAt(m.index! + m[1]!.length), kind: 'import', names: parseNames(m[3]!) });
  }
  for (const m of noComments.matchAll(/(^|[;\n])\s*import\s+["']([^"']+)["']/g)) {
    imports.push({ spec: m[2]!, line: lm.lineAt(m.index! + m[1]!.length), kind: 'import', names: [] });
  }
  for (const m of noComments.matchAll(/(^|[;\n])\s*export\s+(type\s+)?(\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s+["']([^"']+)["']/g)) {
    imports.push({ spec: m[4]!, line: lm.lineAt(m.index! + m[1]!.length), kind: 'reexport', names: parseNames(m[3]!) });
  }
  for (const m of noComments.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    imports.push({ spec: m[1]!, line: lm.lineAt(m.index!), kind: 'require' });
  }
  for (const m of noComments.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    imports.push({ spec: m[1]!, line: lm.lineAt(m.index!), kind: 'dynamic' });
  }

  const lines = code.split('\n');
  const depths = lineDepths(code);
  const stack = new ContainerStack();
  const symbols: SymbolInfo[] = [];
  const exportedNames = new Set<string>();
  for (const m of code.matchAll(/(^|\n)\s*export\s*\{([^}]*)\}\s*;?\s*(?=\n|$)/g)) {
    for (const part of m[2]!.split(',')) {
      const n = part.trim().split(/\s+as\s+/)[0]!.trim();
      if (n) exportedNames.add(n);
    }
  }
  const cjsExports = new Set<string>();
  for (const m of code.matchAll(/\b(?:module\.)?exports\.(\w+)\s*=/g)) cjsExports.add(m[1]!);
  const moduleExportsObj = /module\.exports\s*=\s*\{([^}]*)\}/.exec(code);
  if (moduleExportsObj) for (const part of moduleExportsObj[1]!.split(',')) {
    const n = part.trim().split(':')[0]!.trim();
    if (n) cjsExports.add(n);
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const depth = depths[i] ?? 0;
    stack.sync(depth);
    const lineNo = i + 1;
    const m = DECL.exec(line);
    if (m && !stack.inFunction) {
      const kw = m[6]!;
      const name = m[7]!;
      const exported = Boolean(m[1]) || exportedNames.has(name) || cjsExports.has(name);
      const signature = signatureFrom(src, lineNo);
      let kind: SymbolKind;
      if (kw.startsWith('function')) kind = 'function';
      else if (kw === 'class') kind = 'class';
      else if (kw === 'interface') kind = 'interface';
      else if (kw === 'type') kind = 'type';
      else if (kw.endsWith('enum')) kind = 'enum';
      else if (kw === 'namespace' || kw === 'module') kind = 'module';
      else {
        const rest = line.slice(line.indexOf(name) + name.length);
        const isFn = /^\s*(:[^=]+)?=\s*(async\s+)?(function\b|\([^)]*\)\s*(:\s*[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>|<)/.test(rest);
        kind = isFn ? 'function' : /^[A-Z][A-Z0-9_]+$/.test(name) ? 'constant' : 'variable';
        if (stack.typeName) continue;
      }
      const returnType = kind === 'function' ? returnTypeFrom(signature.replace(/=>.*$/, ''), 'colon') : undefined;
      symbols.push(sym(name, kind, lineNo, signature, { exported, container: stack.typeName, returnType }));
      if (kind === 'class' || kind === 'interface' || kind === 'module' || kind === 'enum') stack.push({ name, depth, type: 'type' });
      else if (kind === 'function') stack.push({ name, depth, type: 'function' });
      continue;
    }
    const top = stack.top;
    if (top?.type === 'type' && depth === top.depth + 1 && !stack.inFunction) {
      const mm = METHOD.exec(line);
      if (mm && !KEYWORDS.has(mm[1]!)) {
        const signature = signatureFrom(src, lineNo);
        symbols.push(
          sym(mm[1]!, 'method', lineNo, signature, {
            exported: !/^\s*(private|#)/.test(line) && !mm[1]!.startsWith('#'),
            container: top.name,
            returnType: returnTypeFrom(signature, 'colon')
          })
        );
        stack.push({ name: mm[1]!, depth, type: 'function' });
      } else if (/^\s*constructor\s*\(/.test(line)) {
        stack.push({ name: 'constructor', depth, type: 'function' });
      }
    }
  }
  const notes: string[] = [];
  if (!typescript && /\bmodule\.exports\b/.test(code) && symbols.length === 0) notes.push('CommonJS exports detected but no declarations matched.');
  return { symbols, imports, resourceRefs: [], notes, fidelity: 'lexical' };
}
